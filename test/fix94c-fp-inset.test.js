// fix94c: the #91 webpack rebuild dropped the first-person inset and the diamond spin.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import { readFileSync } from 'fs';

const require = createRequire(import.meta.url);
const THREE = require('three');
const {
    createFpInset,
    spinBotDiamond,
    INSET_WIDTH_FRACTION,
    INSET_MARGIN_PX,
    DIAMOND_SPIN_PER_FRAME,
    INSET_RENDER_FRAME_INTERVAL,
    INSET_ASPECT_W,
    INSET_ASPECT_H,
    INSET_EYE_HEIGHT,
    MISSING_FP,
} = require('prismarine-viewer/lib/fpInset.js');

function fakeDocument () {
    const body = { children: [], appendChild (node) { this.children.push(node); } };
    return {
        body,
        createElement () { return { style: { cssText: '', display: 'none' } }; },
    };
}

function fakeRenderer (onRender) {
    const calls = [];
    return {
        calls,
        setRenderTarget (target) { calls.push({ op: 'target', target }); },
        render (scene, camera) {
            if (onRender) onRender(scene, camera);
            calls.push({ op: 'render', scene, camera });
        },
        setScissorTest (on) { calls.push({ op: 'scissorTest', on }); },
        setScissor (x, y, w, h) { calls.push({ op: 'scissor', x, y, w, h }); },
        setViewport (x, y, w, h) { calls.push({ op: 'viewport', x, y, w, h }); },
    };
}

function trackRenderTargets () {
    const Original = THREE.WebGLRenderTarget;
    const created = [];
    const disposed = [];
    function TrackingTarget (width, height) {
        const target = new Original(width, height);
        const originalDispose = target.dispose;
        target.dispose = function disposeTracked () {
            disposed.push(target);
            return originalDispose.call(target);
        };
        created.push(target);
        return target;
    }
    THREE.WebGLRenderTarget = TrackingTarget;
    return {
        created,
        disposed,
        restore () { THREE.WebGLRenderTarget = Original; },
    };
}

function harness (viewWindow, getBotMesh, onRender) {
    const errors = [];
    const renderer = fakeRenderer(onRender);
    const world = { name: 'world' };
    const inset = createFpInset({
        renderer,
        scene: world,
        getBotMesh,
        viewWindow,
        document: fakeDocument(),
        console: { error (message) { errors.push(message); } },
    });
    return { errors, renderer, world, inset };
}

describe('fix94c first-person inset', () => {
    it('names the hand-edit sizes in one place', () => {
        assert.strictEqual(INSET_WIDTH_FRACTION, 0.48);
        assert.strictEqual(INSET_MARGIN_PX, 12);
        assert.strictEqual(DIAMOND_SPIN_PER_FRAME, 0.035);
        assert.strictEqual(INSET_RENDER_FRAME_INTERVAL, 2);
        assert.strictEqual(INSET_ASPECT_W, 16);
        assert.strictEqual(INSET_ASPECT_H, 9);
        const src = readFileSync(require.resolve('prismarine-viewer/lib/fpInset.js'), 'utf8');
        assert.match(src, /hand-edit/);
        const index = readFileSync(require.resolve('prismarine-viewer/lib/index.js'), 'utf8');
        const bindAt = index.indexOf('bindViewerPage({');
        const animateAt = index.indexOf('function animate');
        assert.ok(bindAt > 0 && animateAt > bindAt);
    });

    it('logs once and skips the pass when window.__pvFP is missing', () => {
        const viewWindow = { innerWidth: 800, innerHeight: 600 };
        const { errors, renderer, inset } = harness(viewWindow, () => undefined);
        inset.render();
        inset.render();
        assert.deepStrictEqual(errors, [MISSING_FP]);
        assert.strictEqual(renderer.calls.length, 0);
        assert.strictEqual(inset.liveTarget(), null);
        assert.strictEqual(inset.border.style.display, 'none');
    });

    it('throws when window.__pvFP is present but not a pose', () => {
        const viewWindow = { innerWidth: 800, innerHeight: 600, __pvFP: { p: { x: 1 } } };
        const { inset } = harness(viewWindow, () => undefined);
        assert.throws(() => inset.render(), /position is not numeric/);
        viewWindow.__pvFP = { p: { x: 1, y: 2, z: 3 } };
        assert.throws(() => inset.render(), /yaw and pitch/);
    });

    it('hides the current bot mesh for the world pass and follows a replacement', () => {
        const meshA = { visible: true, name: 'a' };
        const meshB = { visible: true, name: 'b' };
        const holder = { bot: meshA };
        const seen = [];
        const viewWindow = {
            innerWidth: 800,
            innerHeight: 600,
            __pvFP: { p: { x: 10, y: 64, z: -4 }, yaw: 0.5, pitch: -0.25 },
        };
        const { renderer, world, inset } = harness(viewWindow, () => holder.bot, (scene) => {
            if (scene === world) seen.push({ a: meshA.visible, b: meshB.visible, current: holder.bot.name });
        });
        inset.render();
        assert.deepStrictEqual(seen, [{ a: false, b: true, current: 'a' }]);
        assert.strictEqual(meshA.visible, true);
        const camera = renderer.calls.find((call) => call.op === 'render' && call.scene === world).camera;
        assert.strictEqual(camera.position.x, 10);
        assert.strictEqual(camera.position.y, 64 + INSET_EYE_HEIGHT);
        assert.strictEqual(camera.position.z, -4);
        assert.strictEqual(camera.rotation.x, -0.25);
        assert.strictEqual(camera.rotation.y, 0.5);

        holder.bot = meshB;
        inset.render();
        inset.render();
        assert.strictEqual(seen.length, 2);
        assert.deepStrictEqual(seen[1], { a: true, b: false, current: 'b' });
        assert.strictEqual(meshA.visible, true);
        assert.strictEqual(meshB.visible, true);

        const worldRenders = renderer.calls.filter((call) => call.op === 'render' && call.scene === world);
        const blits = renderer.calls.filter((call) => call.op === 'render' && call.scene !== world);
        assert.strictEqual(worldRenders.length, 2);
        assert.strictEqual(blits.length, 3);
        const scissor = renderer.calls.find((call) => call.op === 'scissor');
        const w = Math.round(INSET_WIDTH_FRACTION * 800);
        const h = Math.round(INSET_ASPECT_H * w / INSET_ASPECT_W);
        assert.deepStrictEqual(
            [scissor.x, scissor.y, scissor.w, scissor.h],
            [800 - w - INSET_MARGIN_PX, INSET_MARGIN_PX, w, h],
        );
        assert.strictEqual(inset.border.style.display, '');
        assert.match(inset.border.style.cssText, /right:12px/);
        assert.match(inset.border.style.cssText, /48vw/);
        assert.match(inset.border.style.cssText, /16/);
    });

    it('disposes the inset render target on resize and keeps a single live target', () => {
        const targets = trackRenderTargets();
        try {
            const viewWindow = {
                innerWidth: 800,
                innerHeight: 600,
                __pvFP: { p: { x: 1, y: 2, z: 3 }, yaw: 0, pitch: 0 },
            };
            const { inset } = harness(viewWindow, () => undefined);
            inset.render();
            inset.render();
            inset.render();
            inset.render();
            assert.strictEqual(targets.created.length, 1);
            assert.strictEqual(targets.disposed.length, 0);
            assert.strictEqual(inset.liveTarget(), targets.created[0]);
            const firstW = Math.round(INSET_WIDTH_FRACTION * 800);
            assert.strictEqual(targets.created[0].width, firstW);
            assert.strictEqual(targets.created[0].height, Math.round(INSET_ASPECT_H * firstW / INSET_ASPECT_W));

            viewWindow.innerWidth = 1000;
            viewWindow.innerHeight = 700;
            inset.render();
            inset.render();
            inset.render();
            assert.strictEqual(targets.created.length, 2);
            assert.deepStrictEqual(targets.disposed, [targets.created[0]]);
            assert.strictEqual(inset.liveTarget(), targets.created[1]);
            const nextW = Math.round(INSET_WIDTH_FRACTION * 1000);
            assert.strictEqual(targets.created[1].width, nextW);
            assert.strictEqual(targets.created[1].height, Math.round(INSET_ASPECT_H * nextW / INSET_ASPECT_W));
            assert.notStrictEqual(targets.created[0], targets.created[1]);
        } finally {
            targets.restore();
        }
    });

    it('spins the bot diamond by the hand-edit step', () => {
        const marker = { rotation: { y: 0 } };
        spinBotDiamond(marker);
        assert.strictEqual(marker.rotation.y, DIAMOND_SPIN_PER_FRAME);
        spinBotDiamond(marker);
        assert.strictEqual(marker.rotation.y, DIAMOND_SPIN_PER_FRAME + DIAMOND_SPIN_PER_FRAME);
        assert.throws(() => spinBotDiamond(null), /bot diamond required/);
        assert.throws(() => spinBotDiamond({}), /rotation\.y/);
    });

    it('the rebuilt bundle contains the inset path and the spin, and index.html loads v=fix94c', () => {
        const html = readFileSync(require.resolve('prismarine-viewer/public/index.html'), 'utf8');
        const bundle = readFileSync(require.resolve('prismarine-viewer/public/index.js'), 'utf8');
        assert.match(html, /index\.js\?v=fix94c/);
        assert.doesNotMatch(html, /v=fix94b/);
        assert.match(bundle, /WebGLRenderTarget/);
        assert.match(bundle, /setScissor/);
        assert.match(bundle, /__pvFP/);
        assert.match(bundle, /first-person inset skipped: window\.__pvFP is missing/);
        assert.match(bundle, /__pvBotDiamond/);
        assert.match(bundle, /rotation\.y\+=\.035/);
    });
});
