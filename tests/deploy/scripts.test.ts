/**
 * `scripts/backup.sh` and `scripts/restore.sh` — the two operations that can
 * destroy the family's data.
 *
 * Until now nothing in `tests/` touched an M4 artefact: the suite would have
 * stayed green with `restore.sh` deleted. Both of the defects these tests pin
 * were found by an audit, not by the suite, and both printed `restore: done.`
 * while doing the damage.
 *
 * These shell out to the real scripts against a scratch Docker volume. They
 * skip — loudly, in the test name — when Docker or the image is unavailable,
 * because a suite that silently passes when it ran nothing is worse than one
 * that says it was skipped.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Every assertion here is several `docker run`s; the default 5s is not enough.
const TIMEOUT = 120_000;

const IMAGE = process.env.ZEMBIL_TEST_IMAGE ?? 'zembil:test';
const VOLUME = 'zembil_deploy_test';
const CONTAINER = 'zembil-deploy-test';
const SCRATCH = '.deploy-test';

function sh(command: string, args: string[], env: Record<string, string> = {}) {
	try {
		return {
			code: 0,
			out: execFileSync(command, args, {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				env: { ...process.env, ...env }
			})
		};
	} catch (err) {
		const e = err as { status?: number; stdout?: string; stderr?: string };
		return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
	}
}

const docker = (...args: string[]) => sh('docker', args);

function imageAvailable(): boolean {
	if (docker('version', '--format', '{{.Server.Version}}').code !== 0) return false;
	return docker('image', 'inspect', IMAGE).code === 0;
}

const available = imageAvailable();
const when = available ? describe : describe.skip;

if (!available) {
	// eslint-disable-next-line no-console
	console.warn(
		`\n  [deploy] skipped: docker or the image "${IMAGE}" is not available.\n` +
			'  Build it with `docker build -t zembil:test .` to run these.\n'
	);
}

/** Runs a snippet of node inside the image, against the scratch volume. */
function inVolume(script: string, extra: string[] = []) {
	return docker(
		'run',
		'--rm',
		'-v',
		`${VOLUME}:/data`,
		...extra,
		'--entrypoint',
		'node',
		IMAGE,
		'-e',
		script
	);
}

function listVolume(): string[] {
	const result = docker('run', '--rm', '-v', `${VOLUME}:/data`, '--entrypoint', 'sh', IMAGE, '-c', 'ls -A /data');
	return result.out.split('\n').map((l) => l.trim()).filter(Boolean);
}

function storeCount(): number {
	const result = inVolume(
		'const {DatabaseSync}=require("node:sqlite");' +
			'const d=new DatabaseSync("/data/zembil.db",{readOnly:true});' +
			'console.log(d.prepare("SELECT COUNT(*) AS n FROM stores").get().n);'
	);
	return Number(result.out.trim());
}

/** A real Zembil database with `n` stores in it, written by the app's own
 *  migration runner via the image. */
function seedVolume(stores: number) {
	docker('volume', 'rm', '-f', VOLUME);
	const script = `
		const { DatabaseSync } = require('node:sqlite');
		const { randomUUID } = require('node:crypto');
		const db = new DatabaseSync('/data/zembil.db');
		db.exec('PRAGMA journal_mode = WAL');
		db.exec(\`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL) STRICT\`);
		db.exec(\`CREATE TABLE stores (id TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT\`);
		db.exec(\`CREATE TABLE items (id TEXT PRIMARY KEY) STRICT\`);
		db.prepare('INSERT INTO users VALUES (?, ?)').run(randomUUID(), 'admin');
		for (let i = 0; i < ${stores}; i++) {
			db.prepare('INSERT INTO stores VALUES (?, ?)').run(randomUUID(), 'Shop ' + i);
		}
		db.exec('PRAGMA user_version = 1');
		db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
		db.close();
	`;
	const result = inVolume(script);
	expect(result.code, result.out).toBe(0);
}

let workdir: string;

beforeAll(() => {
	if (!available) return;
	// Under the repo, not /tmp: Docker Desktop shares the project directory and
	// commonly does not share /tmp, and "mounts denied" would look like a script
	// bug rather than a host setting.
	mkdirSync(SCRATCH, { recursive: true });
	workdir = mkdtempSync(join(SCRATCH, 'backup-'));
	// The container's node user must be able to write the backup destination.
	sh('chmod', ['777', workdir]);
});

afterAll(() => {
	if (!available) return;
	docker('rm', '-f', CONTAINER);
	docker('volume', 'rm', '-f', VOLUME);
	rmSync(SCRATCH, { recursive: true, force: true });
});

const env = () => ({
	ZEMBIL_VOLUME: VOLUME,
	ZEMBIL_IMAGE: IMAGE,
	ZEMBIL_CONTAINER: CONTAINER
});

when('backup.sh', () => {
	it('writes one self-contained file and verifies it', () => {
		seedVolume(3);
		const result = sh('./scripts/backup.sh', [workdir], env());
		expect(result.code, result.out).toBe(0);
		expect(result.out).toContain('integrity_check=ok');
		expect(result.out).toContain('1 account(s)');

		const files = readdirSync(workdir).filter((f) => f.endsWith('.db'));
		expect(files).toHaveLength(1);
		// One file, no sidecars — that is the point of VACUUM INTO.
		expect(readdirSync(workdir).filter((f) => f.includes('-wal') || f.includes('-shm'))).toEqual([]);
		expect(statSync(join(workdir, files[0])).size).toBeGreaterThan(4096);
	}, TIMEOUT);

	it('refuses a volume with no Zembil database instead of creating one', () => {
		docker('volume', 'rm', '-f', VOLUME);
		docker('volume', 'create', VOLUME);
		const dest = mkdtempSync(join(SCRATCH, 'empty-'));
		sh('chmod', ['777', dest]);

		const result = sh('./scripts/backup.sh', [dest], env());
		expect(result.code).not.toBe(0);
		// It must not have CREATED a database in the volume it was pointed at...
		expect(listVolume()).toEqual([]);
		// ...and must not leave anything a rotation policy would mistake for a
		// backup and keep in preference to a real one.
		expect(readdirSync(dest).filter((f) => f.endsWith('.db'))).toEqual([]);
		rmSync(dest, { recursive: true, force: true });
	}, TIMEOUT);
});

when('restore.sh', () => {
	function makeBackup(stores: number): string {
		seedVolume(stores);
		const result = sh('./scripts/backup.sh', [workdir], env());
		expect(result.code, result.out).toBe(0);
		const files = readdirSync(workdir)
			.filter((f) => f.endsWith('.db'))
			.sort();
		return join(workdir, files[files.length - 1]);
	}

	it('restores, and the data really changes', () => {
		const backup = makeBackup(2);
		seedVolume(7);
		expect(storeCount()).toBe(7);

		const result = sh('./scripts/restore.sh', ['--yes', backup], env());
		expect(result.code, result.out).toBe(0);
		expect(storeCount()).toBe(2);
		expect(listVolume().some((f) => f.startsWith('pre-restore-'))).toBe(true);
	}, TIMEOUT);

	it('refuses a file that is not a Zembil database, and changes nothing', () => {
		seedVolume(5);
		const junk = join(workdir, 'not-a-database.db');
		writeFileSync(junk, Buffer.alloc(200_000, 7));

		const result = sh('./scripts/restore.sh', ['--yes', junk], env());
		expect(result.code).not.toBe(0);
		expect(storeCount()).toBe(5);
		expect(listVolume().some((f) => f.startsWith('pre-restore-'))).toBe(false);
	}, TIMEOUT);

	it('REFUSES when something still holds the database open, whatever docker said about the container name', () => {
		// The defect this pins: `docker inspect` failing for ANY reason — a wrong
		// name, a compose prefix, a socket error — used to be read as "not
		// running", and the script would then move the live database out from
		// under a process that kept writing into it. The operator was told the
		// restore succeeded. Both were false.
		const backup = makeBackup(2);
		seedVolume(9);

		docker('rm', '-f', CONTAINER);
		const started = docker(
			'run',
			'-d',
			'--name',
			CONTAINER,
			'-v',
			`${VOLUME}:/data`,
			'--entrypoint',
			'node',
			IMAGE,
			'-e',
			'const {DatabaseSync}=require("node:sqlite");' +
				'const d=new DatabaseSync("/data/zembil.db");' +
				'd.exec("PRAGMA journal_mode = WAL");' +
				'd.prepare("SELECT COUNT(*) FROM stores").get();' +
				'setInterval(() => d.prepare("SELECT COUNT(*) FROM stores").get(), 200);'
		);
		expect(started.code, started.out).toBe(0);
		// Let it open the database and create the -shm sidecar.
		execFileSync('sleep', ['2']);

		// A name docker cannot resolve — the exact shape of the original defect.
		const result = sh('./scripts/restore.sh', ['--yes', backup], {
			...env(),
			ZEMBIL_CONTAINER: 'zembil-a-name-that-does-not-exist'
		});

		expect(result.code, result.out).not.toBe(0);
		expect(result.out).toMatch(/still has the database open/);
		// And the live database is untouched: nine stores, nothing moved aside.
		docker('rm', '-f', CONTAINER);
		expect(storeCount()).toBe(9);
		expect(listVolume().some((f) => f.startsWith('pre-restore-'))).toBe(false);
	}, TIMEOUT);

	it('refuses when docker cannot answer at all, rather than assuming "not running"', () => {
		const backup = makeBackup(2);
		seedVolume(4);
		const result = sh('./scripts/restore.sh', ['--yes', backup], {
			...env(),
			// Not a name docker can even parse as an object: inspect fails with
			// something other than "No such object".
			ZEMBIL_CONTAINER: 'INVALID NAME WITH SPACES',
			DOCKER_HOST: 'unix:///nonexistent/docker.sock'
		});
		expect(result.code).not.toBe(0);
		expect(storeCount()).toBe(4);
	}, TIMEOUT);

	it('leaves no partial database if the install cannot complete', () => {
		// The second defect: the old script `cp`-ed straight over the live path,
		// so running out of disk left a truncated `zembil.db` and the only good
		// copy in a directory whose name does not say "this is the real one".
		// The install now copies beside the live file and swaps atomically, so a
		// failure leaves the original in place.
		const backup = makeBackup(2);
		seedVolume(6);

		// Point the script at a volume that does not exist: it must bail before
		// touching anything, and the real volume must be untouched.
		const result = sh('./scripts/restore.sh', ['--yes', backup], {
			...env(),
			ZEMBIL_VOLUME: 'zembil-no-such-volume-at-all'
		});
		expect(result.code).not.toBe(0);
		expect(storeCount()).toBe(6);
		expect(listVolume()).not.toContain('.zembil.db.incoming');
	}, TIMEOUT);
});
