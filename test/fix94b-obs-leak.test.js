// fix94b: OBS Bot View leaked a section mesh and a player model on every bot reconnect.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { EventEmitter } from 'events';
import minecraftData from 'minecraft-data';
import prismarineRegistry from 'prismarine-registry';

const require = createRequire(import.meta.url);
const THREE = require('three');

const utils = require('prismarine-viewer/viewer/lib/utils.js');
utils.loadTexture = (url, cb) => {
    const texture = new THREE.Texture();
    texture.userData = { shared: true };
    texture.name = url;
    cb(texture);
};
utils.loadJSON = (_url, cb) => { cb({}); };

global.Worker = class {
    constructor () { this.messages = []; }
    postMessage (message) { this.messages.push(message); }
    on () {}
};

const { WorldRenderer } = require('prismarine-viewer/viewer/lib/worldrenderer.js');
const { dispose3 } = require('prismarine-viewer/viewer/lib/dispose.js');
const { bindViewerPage } = require('prismarine-viewer/lib/viewerPage.js');
const { SECTION_SIZE, columnRangeFromRegistry, versionPayload } = require('prismarine-viewer/viewer/lib/columnRange.js');
const { loadTexture } = require('prismarine-viewer/viewer/lib/utils.web.js');

const RECONNECTS = 8;
const VIEWER_EVENTS = ['entity', 'primitive', 'loadChunk', 'unloadChunk', 'blockUpdate'];

function registryFor (version) {
    const data = minecraftData(version);
    if (!data.loginPacket) throw new Error(`${version} has no loginPacket`);
    if (!data.loginPacket.dimensionCodec) throw new Error(`${version} has no dimension codec`);
    const registry = prismarineRegistry(version);
    const codec = data.loginPacket.dimensionCodec;
    if (data.supportFeature('segmentedRegistryCodecData')) {
        const dimensionType = codec['minecraft:dimension_type'];
        if (!dimensionType) throw new Error(`${version} dimension codec has no minecraft:dimension_type`);
        registry.loadDimensionCodec(dimensionType);
    } else {
        registry.loadDimensionCodec(codec);
    }
    return registry;
}

function overworldBot (version) {
    return {
        version,
        game: { dimension: 'overworld' },
        registry: registryFor(version),
    };
}

function liveGeometries (root) {
    const found = [];
    root.traverse((object) => {
        if (object.geometry) found.push(object.geometry);
    });
    return found;
}

function sectionMesh (material, y) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, y, 0]), 3));
    return new THREE.Mesh(geometry, material);
}

function trackDispose (prototype) {
    const calls = [];
    const original = prototype.dispose;
    prototype.dispose = function trackedDispose () {
        calls.push(this);
        return original.call(this);
    };
    return {
        calls,
        restore () { prototype.dispose = original; },
    };
}

describe('fix94b OBS viewer leak', () => {
    it('dispose3 frees nested geometry, materials and skeletons and skips shared resources', () => {
        const root = new THREE.Group();
        const childGeometry = new THREE.BufferGeometry();
        const grandchildGeometry = new THREE.BufferGeometry();
        let childGeometryDisposes = 0;
        let grandchildGeometryDisposes = 0;
        childGeometry.dispose = () => { childGeometryDisposes++; };
        grandchildGeometry.dispose = () => { grandchildGeometryDisposes++; };

        const ownMap = new THREE.Texture();
        let ownMapDisposes = 0;
        ownMap.dispose = () => { ownMapDisposes++; };
        const childMaterial = new THREE.MeshBasicMaterial({ map: ownMap });
        let childMaterialDisposes = 0;
        childMaterial.dispose = () => { childMaterialDisposes++; };

        const sharedMap = new THREE.Texture();
        sharedMap.userData = { shared: true };
        let sharedMapDisposes = 0;
        sharedMap.dispose = () => { sharedMapDisposes++; };
        const privateMaterial = new THREE.MeshBasicMaterial({ map: sharedMap });
        let privateMaterialDisposes = 0;
        privateMaterial.dispose = () => { privateMaterialDisposes++; };

        const sharedMaterial = new THREE.MeshLambertMaterial();
        sharedMaterial.userData.shared = true;
        const leakedMap = new THREE.Texture();
        let leakedMapDisposes = 0;
        leakedMap.dispose = () => { leakedMapDisposes++; };
        sharedMaterial.map = leakedMap;
        let sharedMaterialDisposes = 0;
        sharedMaterial.dispose = () => { sharedMaterialDisposes++; };

        const child = new THREE.Mesh(childGeometry, childMaterial);
        const grandchild = new THREE.Mesh(grandchildGeometry, [privateMaterial, sharedMaterial]);
        const skeleton = new THREE.Skeleton([new THREE.Bone()]);
        let skeletonDisposes = 0;
        skeleton.dispose = () => { skeletonDisposes++; };
        grandchild.skeleton = skeleton;
        child.add(grandchild);
        root.add(child);

        dispose3(root);

        assert.strictEqual(childGeometryDisposes, 1);
        assert.strictEqual(grandchildGeometryDisposes, 1);
        assert.strictEqual(childMaterialDisposes, 1);
        assert.strictEqual(ownMapDisposes, 1);
        assert.strictEqual(privateMaterialDisposes, 1);
        assert.strictEqual(sharedMapDisposes, 0);
        assert.strictEqual(sharedMaterialDisposes, 0);
        assert.strictEqual(leakedMapDisposes, 0);
        assert.strictEqual(skeletonDisposes, 1);
        assert.throws(() => dispose3(null), /Object3D/);
    });

    it('cached loadTexture textures are marked shared', () => {
        const OriginalLoader = THREE.TextureLoader;
        THREE.TextureLoader = class {
            load () { return new THREE.Texture(); }
        };
        try {
            let texture;
            loadTexture('fix94b-cache-texture.png', (loaded) => { texture = loaded; });
            assert.strictEqual(texture.userData.shared, true);
            let again;
            loadTexture('fix94b-cache-texture.png', (loaded) => { again = loaded; });
            assert.strictEqual(again, texture);
        } finally {
            THREE.TextureLoader = OriginalLoader;
        }
    });

    it('version reconnects keep one listener per event and one bot model', () => {
        const payload = versionPayload(overworldBot('1.20.4'));
        assert.ok(payload.minY < 0, 'overworld registry minY is negative');
        const scene = new THREE.Scene();
        const viewer = {
            scene,
            camera: new THREE.PerspectiveCamera(75, 1, 0.1, 1000),
            versions: [],
            listenCalls: 0,
            setVersion (version, column) {
                this.versions.push({ version, column });
                return true;
            },
            listen (socket) {
                this.listenCalls++;
                for (const name of VIEWER_EVENTS) socket.on(name, () => {});
            },
            setFirstPersonCamera () {},
        };
        const socket = new EventEmitter();
        const controls = {
            current: {
                target: new THREE.Vector3(),
                update () {},
                dispose () {},
            },
        };
        const boxes = [];
        const skeletons = [];
        bindViewerPage({
            socket,
            viewer,
            controls,
            createPlayerMesh () {
                const geometry = new THREE.BoxGeometry(0.2, 0.2, 0.2);
                boxes.push(geometry);
                const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
                const skeleton = new THREE.Skeleton([new THREE.Bone()]);
                skeletons.push(skeleton);
                mesh.skeleton = skeleton;
                const group = new THREE.Group();
                group.add(mesh);
                return group;
            },
        });

        const geometryDisposes = trackDispose(THREE.BufferGeometry.prototype);
        const skeletonDisposes = trackDispose(THREE.Skeleton.prototype);
        try {
            for (let i = 0; i < RECONNECTS; i++) {
                socket.emit('version', payload);
                socket.emit('position', { pos: { x: i, y: 70, z: 3 }, yaw: 0.2, addMesh: true });
                assert.strictEqual(socket.listenerCount('version'), 1);
                assert.strictEqual(socket.listenerCount('position'), 1);
                assert.strictEqual(socket.listenerCount('connect'), 1);
                for (const name of VIEWER_EVENTS) assert.strictEqual(socket.listenerCount(name), 1, name);
                assert.strictEqual(viewer.listenCalls, 1);
                const bots = scene.children.filter((child) => child.userData.viewerBot);
                assert.strictEqual(bots.length, 1);
                assert.strictEqual(bots[0].userData.botDiamond, true);
                assert.ok(bots[0].getObjectByName('botMarker'));
            }
            assert.strictEqual(boxes.length, RECONNECTS);
            assert.strictEqual(skeletons.length, RECONNECTS);
            for (let i = 0; i < RECONNECTS - 1; i++) {
                assert.ok(geometryDisposes.calls.includes(boxes[i]), `box ${i} disposed`);
                assert.ok(skeletonDisposes.calls.includes(skeletons[i]), `skeleton ${i} disposed`);
            }
            assert.ok(!geometryDisposes.calls.includes(boxes[RECONNECTS - 1]));
            assert.strictEqual(viewer.versions.length, RECONNECTS);
            assert.deepStrictEqual(viewer.versions[0].column, { minY: payload.minY, height: payload.height });
            assert.throws(() => socket.emit('version', '1.20.4'), /version, minY, height/);
            assert.strictEqual(socket.listenerCount('position'), 1);
        } finally {
            geometryDisposes.restore();
            skeletonDisposes.restore();
        }
    });

    it('resetWorld disposes every section mesh and removeColumn covers the registry vertical range', () => {
        const bot = overworldBot('1.20.4');
        const payload = versionPayload(bot);
        const nether = columnRangeFromRegistry(bot.registry, 'the_nether');
        assert.ok(payload.minY < 0);
        const top = payload.minY + payload.height - SECTION_SIZE;
        assert.ok(top >= 256, 'registry column extends past the old hardcoded 0..255 loop');
        assert.notStrictEqual(nether.minY, payload.minY);
        assert.throws(() => columnRangeFromRegistry(registryFor('1.16.4'), 'overworld'), /minY/);

        const scene = new THREE.Scene();
        const world = new WorldRenderer(scene, 1);
        assert.strictEqual(world.material.userData.shared, true);
        world.setVersion(payload.version, { minY: payload.minY, height: payload.height });

        const bottom = sectionMesh(world.material, payload.minY);
        const crown = sectionMesh(world.material, top);
        const neighbor = sectionMesh(world.material, payload.minY);
        world.sectionMeshs[`0,${payload.minY},0`] = bottom;
        world.sectionMeshs[`0,${top},0`] = crown;
        world.sectionMeshs[`16,${payload.minY},0`] = neighbor;
        scene.add(bottom);
        scene.add(crown);
        scene.add(neighbor);

        const geometryDisposes = trackDispose(THREE.BufferGeometry.prototype);
        const materialDisposes = trackDispose(THREE.Material.prototype);
        try {
            world.resetWorld();
            assert.deepStrictEqual(world.sectionMeshs, {});
            assert.deepStrictEqual(liveGeometries(scene), []);
            assert.ok(geometryDisposes.calls.includes(bottom.geometry));
            assert.ok(geometryDisposes.calls.includes(crown.geometry));
            assert.ok(geometryDisposes.calls.includes(neighbor.geometry));
            assert.strictEqual(materialDisposes.calls.includes(world.material), false);

            world.setColumnRange({ minY: payload.minY, height: payload.height });
            const low = sectionMesh(world.material, payload.minY);
            const high = sectionMesh(world.material, top);
            const kept = sectionMesh(world.material, payload.minY);
            world.sectionMeshs[`8,${payload.minY},-8`] = low;
            world.sectionMeshs[`8,${top},-8`] = high;
            world.sectionMeshs[`24,${payload.minY},-8`] = kept;
            scene.add(low);
            scene.add(high);
            scene.add(kept);
            const before = geometryDisposes.calls.length;
            world.removeColumn(8, -8);
            assert.ok(geometryDisposes.calls.includes(low.geometry));
            assert.ok(geometryDisposes.calls.includes(high.geometry));
            assert.strictEqual(geometryDisposes.calls.includes(kept.geometry), false);
            assert.strictEqual(world.sectionMeshs[`24,${payload.minY},-8`], kept);
            assert.ok(geometryDisposes.calls.length >= before + 2);
            assert.ok(scene.children.includes(kept));
            assert.strictEqual(scene.children.includes(low), false);
            assert.strictEqual(scene.children.includes(high), false);

            const strayY = payload.minY - SECTION_SIZE;
            const stray = sectionMesh(world.material, strayY);
            world.sectionMeshs[`8,${strayY},-8`] = stray;
            scene.add(stray);
            assert.throws(() => world.removeColumn(8, -8), /outside the registry column range/);
            assert.ok(geometryDisposes.calls.includes(stray.geometry));
            assert.strictEqual(world.sectionMeshs[`8,${strayY},-8`], undefined);

            const dirty = world.workers[0].messages.filter((message) => message.type === 'dirty' && message.x === 0 && message.z === 0);
            world.addColumn(0, 0, {});
            const ys = world.workers[0].messages
                .filter((message) => message.type === 'dirty' && message.x === 0 && message.z === 0)
                .map((message) => message.y);
            assert.ok(ys.includes(payload.minY));
            assert.ok(ys.includes(top));
            assert.strictEqual(ys.length, dirty.length + (payload.height / SECTION_SIZE));
        } finally {
            geometryDisposes.restore();
            materialDisposes.restore();
        }
    });

    it('the served bundle is the webpack build and the cache buster changed', () => {
        const html = readFileSync(require.resolve('prismarine-viewer/public/index.html'), 'utf8');
        const bundle = readFileSync(require.resolve('prismarine-viewer/public/index.js'), 'utf8');
        assert.match(html, /index\.js\?v=fix94c/);
        assert.doesNotMatch(html, /v=zombie1/);
        assert.match(bundle, /userData\.shared/);
        assert.match(bundle, /__pvPlaySound/);
        assert.match(bundle, /__pvBotDiamond/);
        assert.match(bundle, /outside the registry column range/);
        assert.doesNotMatch(bundle, /geometry\?\.dispose\(\)/);
    });
});
