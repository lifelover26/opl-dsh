import { mkdir, readFile, writeFile, cp, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'

async function bundle(options) {
  const result = await build({ ...options, write: false })
  for (const file of result.outputFiles ?? []) await writeFile(file.path, file.contents)
  return result
}

export const pluginNamespaces = {
  base: ['oplSetup', 'oplGatewayAccount', 'oplGatewayModels', 'oplUpdates'],
  execution: ['oplExecution', 'oplAutoReview'],
  collaboration: ['oplCoordination', 'oplRoleExecution', 'taskFeedback'],
}

/** Keep the compiler's schemas and select only the owning package's invocations. */
export function hostContract(source, packageName, namespaces) {
  return source
    .replaceAll('@one-person-lab/dsh-opl', packageName)
    .replace(
      'return $remote.descriptors',
      `return $remote.descriptors.filter(item => ${JSON.stringify(namespaces)}.includes(item.namespace))`,
    )
}

export async function buildFeaturePlugins({ root, output, project, tar, officialClientRuntime }) {
  const features = [
    {
      id: 'execution',
      title: 'OPL 执行组合',
      en: 'OPL Execution',
      description:
        '管理模型与执行引擎的组合，运行 Codex、Claude Code 等 CLI，并保留续作与取消能力。',
      english: 'Manage model and execution-engine combinations and run external CLI sessions.',
      host: 'execution-plugin.ts',
      client: 'execution-client.tsx',
    },
    {
      id: 'collaboration',
      title: 'OPL 跨引擎协作',
      en: 'OPL Collaboration',
      description:
        '为官方角色绑定执行组合，通过官方团队工具协作，并管理跨引擎任务交付。需要启用 OPL 执行组合。',
      english:
        'Bind official roles to execution combinations and connect external engines to official teams. Requires OPL Execution.',
      host: 'collaboration-plugin.ts',
      client: 'collaboration-client.tsx',
    },
  ]
  const artifacts = []
  for (const feature of features) {
    const packageName = '@one-person-lab/dsh-' + feature.id
    const directory = join(output, feature.id + '-package')
    const destination = join(directory, 'package')
    await rm(directory, { recursive: true, force: true })
    await mkdir(join(destination, 'lib'), { recursive: true })
    const host = await bundle({
      entryPoints: [join(root, 'src/suite', feature.host)],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      packages: 'external',
      define: { __OPL_SUITE_VERSION__: JSON.stringify(project.version) },
      tsconfig: join(root, 'tsconfig.host.json'),
      outfile: join(destination, 'lib/index.js'),
      metafile: true,
    })
    const client = await bundle({
      entryPoints: [join(root, 'src/suite', feature.client)],
      bundle: true,
      platform: 'browser',
      format: 'cjs',
      outfile: join(directory, 'client.cjs'),
      external: ['react', 'react/*'],
      plugins: [officialClientRuntime],
      loader: { '.css': 'local-css', '.png': 'dataurl' },
      tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
      metafile: true,
    })
    const script = await readFile(join(directory, 'client.cjs'), 'utf8')
    const css = await readFile(join(directory, 'client.css'), 'utf8').catch(() => '')
    await writeFile(
      join(destination, 'lib/client.js'),
      `window.__ModuleLoader__.load({id:${JSON.stringify(packageName)},factory:(require)=>{const module={exports:{}};const exports=module.exports;${script}\nconst original=module.exports;return {...original,apply(ctx,...args){ctx.effect(()=>{const style=document.createElement('style');style.dataset.oplPlugin=${JSON.stringify(feature.id)};style.textContent=${JSON.stringify(css)};document.head.append(style);return ()=>style.remove()});return original.apply(ctx,...args)}};}});\n`,
    )
    await writeFile(
      join(destination, 'lib/typert.host.js'),
      hostContract(
        await readFile(join(root, 'src/generated/host.mjs'), 'utf8'),
        packageName,
        pluginNamespaces[feature.id],
      ),
    )
    if (feature.id === 'execution') {
      for (const file of await readdir(join(output, 'package/lib'))) {
        if (!file.endsWith('.mjs')) continue
        await cp(join(output, 'package/lib', file), join(destination, 'lib', file))
        await rm(join(output, 'package/lib', file))
      }
      await cp(join(output, 'package/licenses'), join(destination, 'licenses'), { recursive: true })
    }
    const peers = Object.fromEntries(
      [
        ...new Set(
          [
            ...Object.values(host.metafile.outputs),
            ...Object.values(client.metafile.outputs),
          ].flatMap((file) =>
            file.imports
              .filter((item) => item.external && !item.path.startsWith('node:'))
              .map((item) =>
                item.path.startsWith('@')
                  ? item.path.split('/').slice(0, 2).join('/')
                  : item.path.split('/')[0],
              ),
          ),
        ),
      ]
        .filter((name) => name !== 'zod')
        .sort()
        .map((name) => [name, '*']),
    )
    if (feature.id === 'collaboration') {
      peers['@one-person-lab/dsh-execution'] = project.version
      for (const name of [
        '@deepseek-ai/dsh-agent-instructions',
        '@deepseek-ai/dsh-agent-preset-registry',
        '@deepseek-ai/dsh-command-compact',
        '@deepseek-ai/dsh-compaction-basic',
        '@deepseek-ai/dsh-compaction-tool-result-pruner',
        '@deepseek-ai/dsh-persona',
        '@deepseek-ai/dsh-skill-filesystem',
        '@deepseek-ai/dsh-time-context',
        '@deepseek-ai/dsh-tool-ask-user',
        '@deepseek-ai/dsh-tool-bash',
        '@deepseek-ai/dsh-tool-fs',
        '@deepseek-ai/dsh-tool-fs-search',
        '@deepseek-ai/dsh-tool-jobs',
        '@deepseek-ai/dsh-tool-office',
        '@deepseek-ai/dsh-tool-present',
        '@deepseek-ai/dsh-tool-pwsh',
        '@deepseek-ai/dsh-tool-skill',
        '@deepseek-ai/dsh-tool-todo',
        '@deepseek-ai/dsh-tool-web',
      ])
        peers[name] = '*'
    }
    await writeFile(
      join(destination, 'package.json'),
      JSON.stringify(
        {
          name: packageName,
          version: project.version,
          type: 'module',
          license: 'MIT',
          description: feature.english,
          author: project.author,
          homepage: project.homepage,
          repository: project.repository,
          icon: './icon.png',
          main: './lib/index.js',
          exports: {
            '.': './lib/index.js',
            './client': './lib/client.js',
            './typert': './lib/typert.host.js',
            './package.json': './package.json',
            './icon': './icon.png',
            './locale/*.json': './locale/*.json',
          },
          peerDependencies: peers,
          dependencies: { zod: project.devDependencies.zod },
          dsh: {
            bundle: { patch: './cordis.patch.yml' },
            client: {
              inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-settings'],
              platform: 'web',
            },
          },
        },
        null,
        2,
      ) + '\n',
    )
    await writeFile(
      join(destination, 'cordis.patch.yml'),
      `- insert:\n    - id: opl-${feature.id}\n      name: '${packageName}'\n`,
    )
    await mkdir(join(destination, 'locale'), { recursive: true })
    for (const language of ['zh', 'en'])
      await writeFile(
        join(destination, 'locale', language + '.json'),
        JSON.stringify(
          {
            meta: {
              title: language === 'zh' ? feature.title : feature.en,
              description: language === 'zh' ? feature.description : feature.english,
              detail: language === 'zh' ? 'README.md' : 'README.en.md',
            },
          },
          null,
          2,
        ) + '\n',
      )
    await cp(join(root, project.icon), join(destination, 'icon.png'))
    for (const language of ['zh', 'en'])
      await cp(
        join(root, 'docs/plugins', feature.id + '.' + language + '.md'),
        join(destination, language === 'zh' ? 'README.md' : 'README.en.md'),
      )
    for (const file of ['LICENSE', 'NOTICE']) await cp(join(root, file), join(destination, file))
    const plain = `opl-dsh-${feature.id}-${project.version}.tgz`
    execFileSync(tar, ['-czf', join(output, plain), '-C', directory, 'package'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })
    const sha256 = createHash('sha256')
      .update(await readFile(join(output, plain)))
      .digest('hex')
    const name = plain.replace('.tgz', '-' + sha256.slice(0, 12) + '.tgz')
    await cp(join(output, plain), join(output, name))
    artifacts.push({ package: packageName, version: project.version, name, sha256 })
  }
  return artifacts
}
