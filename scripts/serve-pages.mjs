import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve('build');
const base = '/voicebook';
const mimeTypes = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.wasm': 'application/wasm',
	'.webmanifest': 'application/manifest+json',
	'.woff2': 'font/woff2'
};

function fileFor(pathname) {
	if (!pathname.startsWith(base)) return null;
	const relative = normalize(decodeURIComponent(pathname.slice(base.length))).replace(
		/^(\.\.[/\\])+/,
		''
	);
	let target = join(root, relative);
	if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html');
	if (!existsSync(target)) target = join(root, '404.html');
	return target.startsWith(root) ? target : null;
}

createServer((request, response) => {
	const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
	const file = fileFor(pathname);
	if (!file) {
		response.writeHead(404).end('Not found');
		return;
	}
	response.writeHead(file.endsWith('404.html') ? 404 : 200, {
		'content-type': mimeTypes[extname(file)] ?? 'application/octet-stream',
		'cache-control': file.includes('/_app/immutable/')
			? 'public, max-age=31536000, immutable'
			: 'no-cache'
	});
	createReadStream(file).pipe(response);
}).listen(4173, '127.0.0.1', () => {
	console.log('Voicebook Pages preview: http://127.0.0.1:4173/voicebook/');
});
