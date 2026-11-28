// @vitest-environment node
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PortableProfile } from './portable-profile'
import {
  portableEngineStateDirectory,
  relocatePortableProfile,
} from './portable-relocation'

describe('portable startup relocation', () => {
  let directory: string
  let profile: PortableProfile
  let db: Database.Database
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'motrix-portable-'))
    profile = {
      root: 'E:\\Motrix',
      dataDir: directory,
      userDataDir: path.join(directory, 'user-data'),
      workDir: path.join(directory, 'work'),
      tempDir: path.join(directory, 'tmp'),
      downloadsDir: 'E:\\Motrix\\Downloads',
    }
    await mkdir(profile.userDataDir)
    db = new Database(':memory:')
    db.exec(`CREATE TABLE tasks (motrix_id TEXT PRIMARY KEY, save_dir TEXT, final_path TEXT, agg_status TEXT, error_code TEXT, error_detail_key TEXT, error_message TEXT, error_detail_params TEXT);
      CREATE TABLE task_instances (instance_id TEXT PRIMARY KEY, motrix_id TEXT, disk_path TEXT, payload TEXT, status TEXT, transition_phase TEXT);`)
  })
  afterEach(async () => {
    db.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('keeps a fresh profile independent and records the location before task creation', async () => {
    expect(await relocatePortableProfile(profile, db)).toBe(false)
    expect(
      JSON.parse(await readFile(path.join(directory, 'portable.json'), 'utf8'))
        .roots
    ).toEqual(['E:\\Motrix'])
  })

  it('moves settings and tasks, blocks external tasks and retires stale engine state on return', async () => {
    await relocatePortableProfile(profile, db)
    const settings = {
      app: {
        defaultSaveDir: 'E:\\Motrix\\Downloads',
        favorites: ['D:\\External'],
      },
      plugins: {
        example: { config: { secret: 'E:\\Motrix\\opaque-credential' } },
      },
      media: {
        ffmpegBinaryPath: 'E:\\Motrix\\data\\user-data\\binaries\\ffmpeg.exe',
      },
    }
    await writeFile(
      path.join(profile.userDataDir, 'settings.json'),
      JSON.stringify(settings)
    )
    db.prepare(
      'INSERT INTO tasks (motrix_id,save_dir,final_path,agg_status) VALUES (?,?,?,?)'
    ).run(
      'local',
      'E:\\Motrix\\Downloads',
      'E:\\Motrix\\Downloads\\a',
      'paused'
    )
    db.prepare(
      'INSERT INTO tasks (motrix_id,save_dir,final_path,agg_status) VALUES (?,?,?,?)'
    ).run('external', 'D:\\External', 'D:\\External\\b', 'downloading')
    db.prepare('INSERT INTO task_instances VALUES (?,?,?,?,?,?)').run(
      'external-i',
      'external',
      'D:\\External\\b',
      '{}',
      'downloading',
      'renaming'
    )
    const oldEngine = portableEngineStateDirectory(profile)
    await writeFile(path.join(oldEngine, 'aria2.session'), 'old absolute paths')
    const moved = { ...profile, root: 'F:\\Motrix' }
    expect(await relocatePortableProfile(moved, db)).toBe(true)
    expect(
      db
        .prepare(
          "SELECT save_dir, agg_status FROM tasks WHERE motrix_id = 'local'"
        )
        .get()
    ).toEqual({ save_dir: 'F:\\Motrix\\Downloads', agg_status: 'paused' })
    expect(
      db
        .prepare(
          "SELECT final_path, agg_status, error_detail_key FROM tasks WHERE motrix_id = 'external'"
        )
        .get()
    ).toEqual({
      final_path: 'D:\\External\\b',
      agg_status: 'error',
      error_detail_key: 'task.recovery.startup.portableExternalPath',
    })
    const loaded = JSON.parse(
      await readFile(path.join(profile.userDataDir, 'settings.json'), 'utf8')
    )
    expect(loaded.app.defaultSaveDir).toBe('F:\\Motrix\\Downloads')
    expect(loaded.plugins.example.config.secret).toBe(
      'E:\\Motrix\\opaque-credential'
    )
    expect(loaded.app.favorites).toEqual(['D:\\External'])
    await relocatePortableProfile(profile, db)
    expect(await readdir(oldEngine)).toEqual([])
    expect(
      (await readdir(path.dirname(oldEngine))).some((entry) =>
        entry.includes('.previous-')
      )
    ).toBe(true)
  })

  it('retains a relocation journal after failure and can recover after another move', async () => {
    await relocatePortableProfile(profile, db)
    await writeFile(
      path.join(profile.userDataDir, 'settings.json'),
      JSON.stringify({ app: { defaultSaveDir: 'E:\\Motrix\\Downloads' } })
    )
    db.prepare(
      'INSERT INTO tasks (motrix_id,save_dir,final_path,agg_status) VALUES (?,?,?,?)'
    ).run(
      'local',
      'E:\\Motrix\\Downloads',
      'E:\\Motrix\\Downloads\\a',
      'paused'
    )
    db.exec(
      "CREATE TRIGGER fail_move BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'blocked'); END"
    )
    await expect(
      relocatePortableProfile({ ...profile, root: 'F:\\Motrix' }, db)
    ).rejects.toThrow('blocked')
    db.exec('DROP TRIGGER fail_move')
    await relocatePortableProfile({ ...profile, root: 'G:\\Motrix' }, db)
    const settings = JSON.parse(
      await readFile(path.join(profile.userDataDir, 'settings.json'), 'utf8')
    )
    expect(settings.app.defaultSaveDir).toBe('G:\\Motrix\\Downloads')
    expect(db.prepare('SELECT save_dir FROM tasks').get()).toEqual({
      save_dir: 'G:\\Motrix\\Downloads',
    })
  })

  it('retires engine state after a crash between task blocking and cache retirement', async () => {
    await relocatePortableProfile(profile, db)
    const engineDir = portableEngineStateDirectory(profile)
    await writeFile(
      path.join(engineDir, 'aria2.session'),
      'unsafe external path'
    )
    await writeFile(
      path.join(directory, 'portable.json'),
      JSON.stringify({
        version: 1,
        roots: [profile.root],
        engineResetPending: true,
      })
    )
    await relocatePortableProfile(profile, db)
    expect(await readdir(engineDir)).toEqual([])
    expect(
      JSON.parse(await readFile(path.join(directory, 'portable.json'), 'utf8'))
        .engineResetPending
    ).toBe(false)
  })

  it('holds an external final destination even when saveDir is internal and the destination becomes the new root', async () => {
    await relocatePortableProfile(profile, db)
    db.prepare(
      'INSERT INTO tasks (motrix_id,save_dir,final_path,agg_status) VALUES (?,?,?,?)'
    ).run(
      'mixed',
      'E:\\Motrix\\Downloads',
      'F:\\Motrix\\outside.bin',
      'finalizing'
    )
    db.prepare('INSERT INTO task_instances VALUES (?,?,?,?,?,?)').run(
      'mixed-i',
      'mixed',
      'E:\\Motrix\\Downloads\\partial',
      '{}',
      'finalizing',
      'renaming'
    )
    await relocatePortableProfile({ ...profile, root: 'F:\\Motrix' }, db)
    expect(
      db.prepare('SELECT agg_status, error_detail_key FROM tasks').get()
    ).toEqual({
      agg_status: 'error',
      error_detail_key: 'task.recovery.startup.portableExternalPath',
    })
    expect(
      db.prepare('SELECT transition_phase FROM task_instances').get()
    ).toEqual({ transition_phase: 'renaming' })
  })

  it('recovers an interrupted nested move from original settings and database values', async () => {
    profile = { ...profile, root: 'E:\\Motrix\\old' }
    await relocatePortableProfile(profile, db)
    const original = 'E:\\Motrix\\old\\old\\Downloads'
    await writeFile(
      path.join(profile.userDataDir, 'settings.json'),
      JSON.stringify({ app: { defaultSaveDir: original } })
    )
    db.prepare(
      'INSERT INTO tasks (motrix_id,save_dir,final_path,agg_status) VALUES (?,?,?,?)'
    ).run('local', original, `${original}\\a`, 'paused')
    db.prepare(
      'INSERT INTO tasks (motrix_id,save_dir,final_path,agg_status) VALUES (?,?,?,?)'
    ).run('external', 'D:\\External', 'D:\\External\\b', 'downloading')
    db.prepare('INSERT INTO task_instances VALUES (?,?,?,?,?,?)').run(
      'external-i',
      'external',
      'D:\\External\\b',
      '{}',
      'downloading',
      'idle'
    )
    db.exec(
      "CREATE TRIGGER fail_block BEFORE UPDATE OF status ON task_instances BEGIN SELECT RAISE(ABORT, 'blocked'); END"
    )
    const moved = { ...profile, root: 'E:\\Motrix' }
    await expect(relocatePortableProfile(moved, db)).rejects.toThrow('blocked')
    db.exec('DROP TRIGGER fail_block')
    await relocatePortableProfile(moved, db)
    expect(
      JSON.parse(
        await readFile(path.join(profile.userDataDir, 'settings.json'), 'utf8')
      ).app.defaultSaveDir
    ).toBe('E:\\Motrix\\old\\Downloads')
    expect(
      db.prepare("SELECT save_dir FROM tasks WHERE motrix_id='local'").get()
    ).toEqual({ save_dir: 'E:\\Motrix\\old\\Downloads' })
  })

  it('preserves user edits made while relocation is interrupted', async () => {
    await relocatePortableProfile(profile, db)
    const settingsPath = path.join(profile.userDataDir, 'settings.json')
    await writeFile(
      settingsPath,
      JSON.stringify({ app: { defaultSaveDir: 'E:\\Motrix\\Downloads' } })
    )
    db.prepare(
      'INSERT INTO tasks (motrix_id,save_dir,final_path,agg_status) VALUES (?,?,?,?)'
    ).run(
      'local',
      'E:\\Motrix\\Downloads',
      'E:\\Motrix\\Downloads\\a',
      'paused'
    )
    db.exec(
      "CREATE TRIGGER fail_move BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'blocked'); END"
    )
    await expect(
      relocatePortableProfile({ ...profile, root: 'F:\\Motrix' }, db)
    ).rejects.toThrow('blocked')
    db.exec('DROP TRIGGER fail_move')
    const edited = JSON.stringify({
      app: { defaultSaveDir: 'D:\\My selection' },
    })
    await writeFile(settingsPath, edited)
    await expect(
      relocatePortableProfile({ ...profile, root: 'F:\\Motrix' }, db)
    ).rejects.toThrow('edited during relocation')
    expect(await readFile(settingsPath, 'utf8')).toBe(edited)
  })

  it('fails closed on corrupt location history', async () => {
    await writeFile(path.join(directory, 'portable.json'), '{broken')
    await expect(relocatePortableProfile(profile, db)).rejects.toThrow(
      'history is invalid'
    )
  })
})
