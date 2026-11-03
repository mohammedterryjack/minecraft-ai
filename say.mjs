import { io } from 'socket.io-client';
const s = io('http://localhost:8080');
s.on('connect', () => { s.emit('send-message', 'icefox2000', {from:'Mo', message: process.argv[2]}); setTimeout(()=>process.exit(0),800); });
