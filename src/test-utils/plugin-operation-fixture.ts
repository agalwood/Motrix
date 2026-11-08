import type { PluginManifest } from '@shared/types/plugin'
export function textOperationManifest(
  id = 'community.text-tools'
): PluginManifest {
  const reference = { type: 'string' as const, minLength: 36, maxLength: 36 }
  return {
    manifestVersion: 1,
    id,
    name: 'Text tools',
    version: '1.0.0',
    description: '',
    categories: ['post-action'],
    engines: { motrix: '>=2.0.0 <3.0.0' },
    main: 'plugin.js',
    permissions: ['files.selected.read', 'files.selected.write'],
    activationEvents: [`onCommand:${id}.deduplicate`],
    contributes: {
      commands: [
        {
          id: `${id}.deduplicate`,
          title: 'Deduplicate lines',
          execution: 'operation',
          public: false,
          argsSchema: {
            type: 'object',
            properties: {
              input: { ...reference },
              output: { ...reference },
              ignoreCase: { type: 'boolean', default: false },
            },
            required: ['input', 'output', 'ignoreCase'],
            additionalProperties: false,
          },
          resultSchema: {
            type: 'object',
            properties: {
              output: { ...reference },
              lines: { type: 'integer', minimum: 0, maximum: 1048576 },
            },
            required: ['output', 'lines'],
            additionalProperties: false,
          },
        },
      ],
      operations: {
        version: 1,
        items: [
          {
            id: `${id}.deduplicate`,
            title: 'Deduplicate lines',
            command: `${id}.deduplicate`,
            requires: ['operations.v1', 'operations.ui.v1', 'files.text.v1'],
            fields: [
              { field: 'input', label: 'Input file' },
              { field: 'ignoreCase', label: 'Ignore case', widget: 'switch' },
              { field: 'output', label: 'Output file' },
            ],
            files: {
              input: { kind: 'input-file', use: 'text', extensions: ['txt'] },
              output: {
                kind: 'output-file',
                use: 'text',
                extensions: ['txt'],
                suggestedName: { stemFrom: 'input', suffix: '-unique' },
              },
            },
            entries: [
              { surface: 'plugin-detail' },
              {
                surface: 'task-menu',
                selection: {
                  count: { min: 1, max: 1 },
                  every: { status: 'completed', files: 'single', local: true },
                },
                bind: { input: { source: 'task-file', index: 0 } },
              },
            ],
            ui: {
              layout: {
                type: 'stack',
                children: [
                  { type: 'field', field: 'input' },
                  {
                    type: 'group',
                    title: 'Matching options',
                    collapsible: true,
                    children: [{ type: 'field', field: 'ignoreCase' }],
                  },
                  { type: 'field', field: 'output' },
                ],
              },
              repeat: 'preserve-inputs',
            },
            result: { fields: ['lines'], files: ['output'] },
          },
        ],
      },
    },
  }
}
export const textOperationBundle = `import { commands } from 'motrix:plugin-api';
commands.registerOperation('community.text-tools.deduplicate', async (args, context) => {
  const text = await context.files.readText(args.input);
  const seen = new Set();
  const lines = text.split('\\n').filter(line => { const key = args.ignoreCase ? line.toLowerCase() : line; if (seen.has(key)) return false; seen.add(key); return true; });
  await context.progress({phase: 'running', fraction: 0.5});
  await context.files.writeText(args.output, lines.join('\\n'));
  return {output: args.output, lines: lines.length};
});`
