import { describe, expect, it } from 'vitest';
import {
  isSensitiveLocalPath,
  isSensitiveRemotePath,
  isWithinRemoteDirectory,
  normalizeRemoteDirectory
} from '../../src/agent/remoteWritePolicy';

describe('normalizeRemoteDirectory', () => {
  it('strips trailing separators and collapses repeats', () => {
    expect(normalizeRemoteDirectory('/home/deploy/')).toBe('/home/deploy');
    expect(normalizeRemoteDirectory('/home//deploy//app/')).toBe('/home/deploy/app');
    expect(normalizeRemoteDirectory('/')).toBe('/');
    expect(normalizeRemoteDirectory('')).toBe('/');
  });
});

describe('isWithinRemoteDirectory', () => {
  it('accepts the root itself and its descendants', () => {
    expect(isWithinRemoteDirectory('/home/deploy', '/home/deploy')).toBe(true);
    expect(isWithinRemoteDirectory('/home/deploy', '/home/deploy/app/config.yml')).toBe(true);
    expect(isWithinRemoteDirectory('/home/deploy/', '/home/deploy/app/')).toBe(true);
  });

  it('rejects siblings that merely share a name prefix', () => {
    expect(isWithinRemoteDirectory('/home/deploy', '/home/deploy-backup/x')).toBe(false);
    expect(isWithinRemoteDirectory('/home/deploy', '/home/deployment')).toBe(false);
  });

  it('rejects anything above or beside the root', () => {
    expect(isWithinRemoteDirectory('/home/deploy', '/etc/cron.d/task')).toBe(false);
    expect(isWithinRemoteDirectory('/home/deploy', '/home')).toBe(false);
    expect(isWithinRemoteDirectory('/home/deploy', '/')).toBe(false);
  });
});

describe('isSensitiveRemotePath', () => {
  it.each([
    '/home/deploy/.ssh/authorized_keys',
    '/root/.ssh/id_ed25519',
    '/home/deploy/.ssh',
    '/etc/cron.d/backup',
    '/etc',
    '/etc/sudoers',
    '/etc/sudoers.d/90-deploy',
    '/etc/systemd/system/evil.service',
    '/home/deploy/.config/systemd/user/evil.service',
    '/home/deploy/.config/systemd/user/evil.timer',
    '/usr/local/bin/deploy',
    '/usr',
    '/bin/ls',
    '/sbin/init',
    '/boot/grub/grub.cfg',
    '/root/notes.txt',
    '/var/spool/cron/crontabs/deploy',
    '/home/deploy/crontab',
    '/home/deploy/.bashrc',
    '/home/deploy/.profile',
    '/somewhere/authorized_keys'
  ])('treats %j as sensitive', (path) => {
    expect(isSensitiveRemotePath(path)).toBe(true);
  });

  it.each([
    '/home/deploy/app/config.yml',
    '/home/deploy/notes.md',
    '/var/www/html/index.html',
    '/opt/app/release.json',
    '/tmp/scratch.txt',
    '/home/deploy/etc/app.conf',
    '/home/deploy/usrdata.txt',
    '/home/deploy/service.yml'
  ])('treats %j as ordinary', (path) => {
    expect(isSensitiveRemotePath(path)).toBe(false);
  });
});

/**
 * The local half of an upload.
 *
 * An upload is the one agent operation that reads the user's own machine, so the question here
 * is not "may this be written" but "is this a credential about to leave the laptop". The check
 * is lexical by necessity — it runs before anything has been authorized, so it must not touch
 * the disk — which is why it only decides whether the dialog asks twice.
 */
describe('isSensitiveLocalPath', () => {
  it.each([
    '/Users/deploy/.ssh/id_rsa',
    '/Users/deploy/.ssh/authorized_keys',
    '/Users/deploy/.aws/credentials',
    '/Users/deploy/.gnupg/private-keys-v1.d/abc.key',
    '/Users/deploy/.dsh/settings.json',
    '/home/deploy/.kube/config',
    '/home/deploy/.docker/config.json',
    '/Users/deploy/project/certs/deploy.pem',
    '/Users/deploy/.netrc',
    '/Users/deploy/project/.env',
    '/tmp/id_ed25519',
    '/tmp/id_ecdsa',
    '/tmp/id_dsa',
    'C:\\Users\\deploy\\.ssh\\id_rsa',
    '/Users/deploy/Documents/../.ssh/id_rsa'
  ])('treats %j as sensitive', (path) => {
    expect(isSensitiveLocalPath(path)).toBe(true);
  });

  it.each([
    '/Users/deploy/project/target/release/at-pc-server',
    '/tmp/at-pc-server-linux-x86_64',
    '/Users/deploy/project/dist/app.js',
    '/Users/deploy/project/.env.example',
    '/Users/deploy/project/README.md',
    '/Users/deploy/project/.github/workflows/ci.yml',
    '/home/deploy/.kube/cache/discovery',
    '/home/deploy/.docker/daemon.json',
    'C:\\Users\\deploy\\project\\dist\\app.exe'
  ])('treats %j as ordinary', (path) => {
    expect(isSensitiveLocalPath(path)).toBe(false);
  });
});
