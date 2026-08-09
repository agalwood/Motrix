import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

export interface AssembleArgs {
  outPath: string
  initPath?: string
  partPaths: string[]
}

export async function assembleSegments(args: AssembleArgs): Promise<void> {
  const { outPath, initPath, partPaths } = args

  const writeStream = createWriteStream(outPath)

  try {
    // Write init file first if provided
    if (initPath) {
      const initStream = createReadStream(initPath)
      await pipeline(initStream, writeStream, { end: false })
    }

    // Pipe each part file in order, preserving write stream
    for (const partPath of partPaths) {
      const partStream = createReadStream(partPath)
      await pipeline(partStream, writeStream, { end: false })
    }

    // Close the write stream
    writeStream.end()

    // Wait for the close event
    await new Promise<void>((resolve, reject) => {
      writeStream.on('close', () => resolve())
      writeStream.on('error', (err) => reject(err))
    })
  } catch (err) {
    writeStream.destroy()
    throw err
  }
}
