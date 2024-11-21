import path from 'node:path'
import Debug from 'debug'

export const debug: Debug.Debugger = Debug('unplugin-isolated-decl')

export function lowestCommonAncestor(...filepaths: string[]): string {
  if (filepaths.length === 0) return ''
  if (filepaths.length === 1) return path.dirname(filepaths[0])
  filepaths = filepaths.map((p) => p.replaceAll('\\', '/'))
  const [first, ...rest] = filepaths
  let ancestor = first.split('/')
  for (const filepath of rest) {
    const directories = filepath.split('/', ancestor.length)
    let index = 0
    for (const directory of directories) {
      if (directory === ancestor[index]) {
        index += 1
      } else {
        ancestor = ancestor.slice(0, index)
        break
      }
    }
    ancestor = ancestor.slice(0, index)
  }

  return ancestor.length <= 1 && ancestor[0] === ''
    ? `/${ancestor[0]}`
    : ancestor.join('/')
}

export function stripExt(filename: string): string {
  return filename.replace(/\.(.?)[jt]sx?$/, '')
}

export function resolveEntry(input: string[] | Record<string, string>): {
  map: Record<string, string> | undefined
  outBase: string
} {
  const map = !Array.isArray(input)
    ? Object.fromEntries(
        Object.entries(input).map(([k, v]) => [
          path.resolve(stripExt(v as string)),
          k,
        ]),
      )
    : undefined
  const arr = Array.isArray(input) && input ? input : Object.values(input)
  const outBase = lowestCommonAncestor(...arr)

  return { map, outBase }
}
