// Synthetic, copyright-free fixtures for the real BrawlLib parsing/rebuilding tests.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function msbin(messages = ['Hello from BrawlCrate', 'Second message']) {
  const payloads = messages.map(text => Buffer.from(text, 'utf8'));
  const header = Buffer.alloc((messages.length + 1) * 4);
  let offset = header.length;
  header.writeUInt32BE(offset, 0);
  payloads.forEach((payload, index) => {
    offset += payload.length;
    header.writeUInt32BE(offset, (index + 1) * 4);
  });
  return Buffer.concat([header, ...payloads]);
}

export function arc(name = 'McpFixture', children = []) {
  if (!/^[\x20-\x7e]{1,47}$/.test(name)) throw new Error('ARC fixture name must be 1..47 printable ASCII characters.');
  if (children.length > 65535) throw new Error('Too many ARC fixture children.');
  const header = Buffer.alloc(64);
  header.write('ARC\0', 0, 'ascii');
  header[4] = 1;
  header[5] = 1;
  header.writeUInt16BE(children.length, 6);
  header.write(name, 16, 'ascii');
  const parts = [header];
  children.forEach((child, index) => {
    const entry = Buffer.alloc(32);
    entry.writeInt16BE(1, 0); // ARCFileType.MiscData
    entry.writeInt16BE(index, 2);
    entry.writeUInt32BE(child.length, 4);
    entry.writeInt16BE(-1, 10); // No redirect.
    parts.push(entry, child, Buffer.alloc((32 - (child.length % 32)) % 32));
  });
  return Buffer.concat(parts);
}

export async function writeFixtures(directory) {
  await mkdir(directory, { recursive: true });
  const files = {
    'empty.pac': arc('EmptyArchive'),
    'nested.pac': arc('McpFixture', [arc('First'), arc('Second'), arc('Third')]),
    'messages.msbin': msbin(),
    'mixed.pac': arc('MixedFixture', [arc('Nested', [msbin(['Nested message'])]), msbin()]),
    'unicode.msbin': msbin(['Hej världen', 'First line\nSecond line', 'こんにちは']),
  };
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(directory, name), content)));
  return Object.fromEntries(Object.keys(files).map(name => [name, join(directory, name)]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node fixtures.mjs <disposable-output-directory>');
  console.log(JSON.stringify(await writeFixtures(resolve(process.argv[2])), null, 2));
}
