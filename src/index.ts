/**
 * This entry file is for main unplugin.
 * @module
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createFilter } from '@rollup/pluginutils'
import MagicString from 'magic-string'
import { parseAsync } from 'oxc-parser'
import {
  createUnplugin,
  type UnpluginBuildContext,
  type UnpluginContext,
  type UnpluginInstance,
} from 'unplugin'
import { filterImports, rewriteImports, type OxcImport } from './core/ast'
import { resolveOptions, type Options } from './core/options'
import {
  oxcTransform,
  swcTransform,
  tsTransform,
  type TransformResult,
} from './core/transformer'
import {
  debug,
  lowestCommonAncestor,
  resolveEntry,
  stripExt,
} from './core/utils'
import type {
  JsPlugin,
  NormalizedConfig,
  ResolvedCompilation,
} from '@farmfe/core'
import type { PluginBuild } from 'esbuild'
import type {
  NormalizedInputOptions,
  NormalizedOutputOptions,
  Plugin,
  PluginContext,
} from 'rollup'

export type { Options }

interface Output {
  s: MagicString
  imports: OxcImport[]
}

/**
 * The main unplugin instance.
 */
export const IsolatedDecl: UnpluginInstance<Options | undefined, false> =
  createUnplugin((rawOptions = {}) => {
    const options = resolveOptions(rawOptions)
    const filter = createFilter(options.include, options.exclude)

    let farmPluginContext: UnpluginBuildContext

    const outputFiles: Record<string, Output> = {}
    function addOutput(filename: string, output: Output) {
      const name = stripExt(filename)
      debug('Add output:', name)
      outputFiles[name] = output
    }

    const rollup: Partial<Plugin> = {
      renderStart: rollupRenderStart,
    }
    const farm: Partial<JsPlugin> = {
      renderStart: { executor: farmRenderStart },
    }

    return {
      name: 'unplugin-isolated-decl',

      buildStart() {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        farmPluginContext = this
      },

      transformInclude: (id) => filter(id),
      transform(code, id): Promise<undefined> {
        return transform(this, code, id)
      },

      esbuild: { setup: esbuildSetup },
      rollup,
      rolldown: rollup as any,
      vite: {
        apply: 'build',
        enforce: 'pre',
        ...rollup,
      },
      farm,
    }

    async function transform(
      context: UnpluginBuildContext & UnpluginContext,
      code: string,
      id: string,
    ): Promise<undefined> {
      const label = debug.enabled && `[${options.transformer}]`
      debug(label, 'transform', id)

      let result: TransformResult
      switch (options.transformer) {
        case 'oxc':
          result = await oxcTransform(id, code)
          break
        case 'swc':
          result = await swcTransform(id, code)
          break
        case 'typescript':
          result = await tsTransform(
            id,
            code,
            (options as any).transformOptions,
          )
      }
      const { code: dts, errors } = result
      debug(
        label,
        'transformed',
        id,
        errors.length ? 'with errors' : 'successfully',
      )
      if (errors.length) {
        if (options.ignoreErrors) {
          context.warn(errors[0])
        } else {
          context.error(errors[0])
          return
        }
      }

      const { program } = await parseAsync(dts, { sourceFilename: id })
      const imports = filterImports(program)

      const s = new MagicString(dts)
      if (options.autoAddExts || options.rewriteImports) {
        for (const i of imports) {
          const { source } = i
          let { value } = source

          if (options.rewriteImports) {
            const result = options.rewriteImports(value, id)
            if (typeof result === 'string') {
              value = result
            }
          }

          if (
            options.autoAddExts &&
            (path.isAbsolute(value) || value[0] === '.') &&
            !path.basename(value).includes('.')
          ) {
            const resolved = await resolve(context, value, id)
            if (!resolved || resolved.external) continue
            if (resolved.id.endsWith('.ts') || resolved.id.endsWith('.tsx')) {
              value = value + (i.suffix = '.js')
            }
          }

          if (source.value !== value) {
            source.originalValue = source.value
            source.value = value
            s.overwrite(source.start + 1, source.end - 1, value)
          }
        }
      }
      addOutput(id, { s, imports })

      const typeImports = program.body.filter((node): node is OxcImport => {
        if (!('source' in node) || !node.source) return false
        if ('importKind' in node && node.importKind === 'type') return true
        if ('exportKind' in node && node.exportKind === 'type') return true

        if (node.type === 'ImportDeclaration') {
          return (
            !!node.specifiers &&
            node.specifiers.every(
              (spec) =>
                spec.type === 'ImportSpecifier' && spec.importKind === 'type',
            )
          )
        }
        return (
          node.type === 'ExportNamedDeclaration' &&
          node.specifiers &&
          node.specifiers.every((spec) => spec.exportKind === 'type')
        )
      })
      for (const i of typeImports) {
        const { source } = i
        const resolved = (
          await resolve(context, source.originalValue || source.value, id)
        )?.id
        if (resolved && filter(resolved) && !outputFiles[stripExt(resolved)]) {
          let source: string
          try {
            source = await readFile(resolved, 'utf8')
          } catch {
            continue
          }
          debug('transform type import:', resolved)
          await transform(context, source, resolved)
        }
      }
    }

    function rollupRenderStart(
      this: PluginContext,
      outputOptions: NormalizedOutputOptions,
      inputOptions: NormalizedInputOptions,
    ) {
      const { input } = inputOptions
      const { inputBase, entryMap } = resolveEntry(input)
      debug('[rollup] input base:', inputBase)

      if (typeof outputOptions.entryFileNames !== 'string') {
        return this.error('entryFileNames must be a string')
      }

      let { entryFileNames } = outputOptions
      if (options.extraOutdir) {
        entryFileNames = path.join(options.extraOutdir, entryFileNames)
      }

      for (const [srcFilename, { s, imports }] of Object.entries(outputFiles)) {
        const emitName = rewriteImports(
          s,
          imports,
          entryMap,
          inputBase,
          entryFileNames,
          srcFilename,
        )

        let source = s.toString()
        if (options.patchCjsDefaultExport && emitName.endsWith('.d.cts')) {
          source = patchCjsDefaultExport(source)
        }

        debug('[rollup] emit dts file:', emitName)
        this.emitFile({
          type: 'asset',
          fileName: emitName,
          source,
        })
      }
    }

    function farmRenderStart(
      config: NormalizedConfig['compilationConfig']['config'],
    ) {
      const { input = {}, output = {} } = config as ResolvedCompilation
      const { inputBase, entryMap } = resolveEntry(
        input as Record<string, string>,
      )
      debug('[farm] out base:', inputBase)

      if (output && typeof output.entryFilename !== 'string') {
        return console.error('entryFileName must be a string')
      }
      const extFormatMap = new Map([
        ['cjs', 'cjs'],
        ['esm', 'js'],
        ['mjs', 'js'],
      ])

      // TODO format normalizeName `entryFilename` `filenames`
      output.entryFilename = '[entryName].[ext]'

      output.entryFilename = output.entryFilename.replace(
        '[ext]',
        extFormatMap.get(output.format || 'esm') || 'js',
      )

      let entryFileNames = output.entryFilename
      if (options.extraOutdir) {
        entryFileNames = path.join(options.extraOutdir, entryFileNames)
      }
      for (const [srcFilename, { s, imports }] of Object.entries(outputFiles)) {
        const emitName = rewriteImports(
          s,
          imports,
          entryMap,
          inputBase,
          entryFileNames,
          srcFilename,
        )

        let source = s.toString()
        if (options.patchCjsDefaultExport && emitName.endsWith('.d.cts')) {
          source = patchCjsDefaultExport(source)
        }

        debug('[farm] emit dts file:', emitName)
        farmPluginContext.emitFile({
          type: 'asset',
          fileName: emitName,
          source,
        })
      }
    }

    function esbuildSetup(build: PluginBuild) {
      build.onEnd(async (result) => {
        const esbuildOptions = build.initialOptions

        const entries = esbuildOptions.entryPoints
        if (
          !(
            entries &&
            Array.isArray(entries) &&
            entries.every((entry) => typeof entry === 'string')
          )
        )
          throw new Error('unsupported entryPoints, must be an string[]')

        const inputBase = lowestCommonAncestor(...entries)
        debug('[esbuild] out base:', inputBase)

        const jsExt = esbuildOptions.outExtension?.['.js']
        let outExt: string
        switch (jsExt) {
          case '.cjs':
            outExt = 'cts'
            break
          case '.mjs':
            outExt = 'mts'
            break
          default:
            outExt = 'ts'
            break
        }

        const write = build.initialOptions.write ?? true
        if (write) {
          if (!build.initialOptions.outdir)
            throw new Error('outdir is required when write is true')
        } else {
          result.outputFiles ||= []
        }

        const textEncoder = new TextEncoder()
        for (const [filename, { s }] of Object.entries(outputFiles)) {
          const outDir = build.initialOptions.outdir
          let outFile = `${path.relative(inputBase, filename)}.d.${outExt}`
          if (options.extraOutdir) {
            outFile = path.join(options.extraOutdir, outFile)
          }
          const filePath = outDir ? path.resolve(outDir, outFile) : outFile

          let source = s.toString()
          if (options.patchCjsDefaultExport && filePath.endsWith('.d.cts')) {
            source = patchCjsDefaultExport(source)
          }

          if (write) {
            await mkdir(path.dirname(filePath), { recursive: true })
            await writeFile(filePath, source)
            debug('[esbuild] write dts file:', filePath)
          } else {
            debug('[esbuild] emit dts file:', filePath)
            result.outputFiles!.push({
              path: filePath,
              contents: textEncoder.encode(source),
              hash: '',
              text: source,
            })
          }
        }
      })
    }
  })

async function resolve(
  context: UnpluginBuildContext,
  id: string,
  importer: string,
): Promise<{ id: string; external: boolean } | undefined> {
  const nativeContext = context.getNativeBuildContext?.()
  switch (nativeContext?.framework) {
    case 'esbuild': {
      const resolved = await nativeContext?.build.resolve(id, {
        importer,
        resolveDir: path.dirname(importer),
        kind: 'import-statement',
      })
      return {
        id: resolved?.path,
        external: resolved?.external,
      }
    }
    case 'farm': {
      const resolved = await nativeContext?.context.resolve(
        { source: id, importer, kind: 'import' },
        {
          meta: {},
          caller: 'unplugin-isolated-decl',
        },
      )
      return { id: resolved.resolvedPath, external: !!resolved.external }
    }
    default: {
      const resolved = await (context as PluginContext).resolve(id, importer)
      if (!resolved) return
      return { id: resolved.id, external: !!resolved.external }
    }
  }
}

function patchCjsDefaultExport(source: string) {
  return source.replace(
    /(?<=(?:[;}]|^)\s*export\s*)(?:\{\s*([\w$]+)\s*as\s+default\s*\}|default\s+([\w$]+))/,
    (_, s1, s2) => `= ${s1 || s2}`,
  )
}
