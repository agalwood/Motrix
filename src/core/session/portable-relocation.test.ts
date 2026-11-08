import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  capturePortableDatabase,
  relocatePortableDatabase,
  relocatePortablePath,
  relocatePortableValue,
} from './portable-relocation'

describe('portable path relocation', () => {
  it.each([
    [
      'E:\\Motrix\\Downloads\\片段.bin',
      'F:\\Apps\\Motrix\\Downloads\\片段.bin',
    ],
    ['e:/motrix/data/work/meta', 'F:\\Apps\\Motrix\\data\\work\\meta'],
    ['E:\\Motrix-old\\x', 'E:\\Motrix-old\\x'],
    ['E:\\Motrix\\..\\other\\x', 'E:\\Motrix\\..\\other\\x'],
    ['D:\\Downloads\\x', 'D:\\Downloads\\x'],
    ['https://host/E:/Motrix/x', 'https://host/E:/Motrix/x'],
    ['Movies/part.mkv', 'Movies/part.mkv'],
  ])('relocates only contained absolute paths: %s', (input, expected) => {
    expect(
      relocatePortablePath(input, ['E:\\Motrix'], 'F:\\Apps\\Motrix')
    ).toBe(expected)
  })
  it('handles UNC roots and repeated recovery without applying the move twice', () => {
    const value = {
      paths: ['\\\\server\\share\\Motrix\\Downloads\\a'],
      secret: 'box:abc:def',
    }
    const moved = relocatePortableValue(
      value,
      ['\\\\server\\share\\Motrix'],
      'E:\\Motrix'
    )
    expect(moved).toEqual({
      paths: ['E:\\Motrix\\Downloads\\a'],
      secret: 'box:abc:def',
    })
    expect(
      relocatePortableValue(moved, ['\\\\server\\share\\Motrix'], 'E:\\Motrix')
    ).toEqual(moved)
  })
  it('relocates HTTP/BT records, nested recovery payloads and composite file keys atomically', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE tasks (motrix_id TEXT PRIMARY KEY, save_dir TEXT, final_path TEXT, torrent_meta_path TEXT);
      CREATE TABLE task_instances (instance_id TEXT PRIMARY KEY, disk_path TEXT, payload TEXT);
      CREATE TABLE task_files (motrix_id TEXT, file_index INTEGER, path TEXT, PRIMARY KEY(motrix_id, file_index)) WITHOUT ROWID;`)
    db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?)').run(
      'task',
      'E:\\Motrix\\Downloads',
      'E:\\Motrix\\Downloads\\a',
      'E:\\Motrix\\data\\user-data\\torrents\\a.torrent'
    )
    const payload = {
      btStorageLayout: {
        workspacePath: 'E:\\Motrix\\Downloads\\.motrix\\task',
      },
      metadataDir: 'E:\\Motrix\\data\\work\\metadata',
      headers: {
        Authorization: 'E:\\Motrix\\opaque-credential',
        path: 'E:\\Motrix\\opaque-header',
      },
      config: { path: 'E:\\Motrix\\opaque-plugin-config' },
    }
    db.prepare('INSERT INTO task_instances VALUES (?, ?, ?)').run(
      'instance',
      'E:\\Motrix\\Downloads\\a.aria2',
      JSON.stringify(payload)
    )
    db.prepare('INSERT INTO task_files VALUES (?, ?, ?)').run(
      'task',
      1,
      'E:\\Motrix\\Downloads\\a'
    )
    const snapshot = capturePortableDatabase(db)
    db.exec(
      "CREATE TRIGGER fail_relocation BEFORE UPDATE ON task_files BEGIN SELECT RAISE(ABORT, 'blocked'); END"
    )
    expect(() =>
      relocatePortableDatabase(db, snapshot, 'E:\\Motrix', 'F:\\Motrix')
    ).toThrow('blocked')
    expect(db.prepare('SELECT final_path FROM tasks').get()).toEqual({
      final_path: 'E:\\Motrix\\Downloads\\a',
    })
    db.exec('DROP TRIGGER fail_relocation')
    relocatePortableDatabase(db, snapshot, 'E:\\Motrix', 'F:\\Motrix')
    expect(db.prepare('SELECT path FROM task_files').get()).toEqual({
      path: 'F:\\Motrix\\Downloads\\a',
    })
    const row = db.prepare('SELECT payload FROM task_instances').get() as {
      payload: string
    }
    expect(JSON.parse(row.payload)).toEqual({
      ...payload,
      btStorageLayout: {
        workspacePath: 'F:\\Motrix\\Downloads\\.motrix\\task',
      },
      metadataDir: 'F:\\Motrix\\data\\work\\metadata',
    })
    db.close()
  })
})

it.each([
  ['E:\\Motrix', 'E:\\Motrix\\new'],
  ['E:\\Motrix\\old', 'E:\\Motrix'],
])(
  'handles moving between nested directories: %s -> %s',
  (oldRoot, newRoot) => {
    const expected = `${newRoot}\\Downloads\\a`
    expect(
      relocatePortablePath(`${oldRoot}\\Downloads\\a`, [oldRoot], newRoot)
    ).toBe(expected)
    // Retry idempotence belongs to snapshot replay, not path-string heuristics.
  }
)

it('replays original values when an ancestor move leaves paths inside the old prefix', () => {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE tasks (motrix_id TEXT PRIMARY KEY, final_path TEXT)')
  db.prepare('INSERT INTO tasks VALUES (?, ?)').run(
    'task',
    'E:\\Motrix\\old\\old\\file'
  )
  const snapshot = capturePortableDatabase(db)
  relocatePortableDatabase(db, snapshot, 'E:\\Motrix\\old', 'E:\\Motrix')
  relocatePortableDatabase(db, snapshot, 'E:\\Motrix\\old', 'E:\\Motrix', [
    'E:\\Motrix',
  ])
  expect(db.prepare('SELECT final_path FROM tasks').get()).toEqual({
    final_path: 'E:\\Motrix\\old\\file',
  })
  relocatePortableDatabase(db, snapshot, 'E:\\Motrix\\old', 'G:\\Motrix', [
    'E:\\Motrix',
  ])
  expect(db.prepare('SELECT final_path FROM tasks').get()).toEqual({
    final_path: 'G:\\Motrix\\old\\file',
  })
  db.close()
})

it('refuses to overwrite a task path edited after the relocation snapshot', () => {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE tasks (motrix_id TEXT PRIMARY KEY, final_path TEXT)')
  db.prepare('INSERT INTO tasks VALUES (?, ?)').run(
    'task',
    'E:\\Motrix\\Downloads\\a'
  )
  const snapshot = capturePortableDatabase(db)
  db.prepare('UPDATE tasks SET final_path = ?').run('D:\\User-selected\\a')
  expect(() =>
    relocatePortableDatabase(db, snapshot, 'E:\\Motrix', 'F:\\Motrix')
  ).toThrow('edited during recovery')
  expect(db.prepare('SELECT final_path FROM tasks').get()).toEqual({
    final_path: 'D:\\User-selected\\a',
  })
  db.close()
})
