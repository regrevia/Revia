import {
  demoResourceCatalog,
  demoResourceParents,
} from './demo-resource-contract.js'

export function demoSchemaDefinitions() {
  return [
    {
      identity: 'process.args',
      revision: '0.1.0',
      resource_catalog: demoResourceCatalog(['process.argv']),
      types: {
        'process.args_error': {
          kind: 'error-sum',
          variants: ['invalid_utf8'],
        },
      },
      members: {
        read: {
          access: ['read process.argv'],
          params: [],
          returns: 'result<list<text.utf8>, process.args_error>',
        },
      },
    },
    {
      identity: 'fs.read',
      revision: '0.1.0',
      resource_catalog: demoResourceCatalog(['fs.file', 'fs.storage']),
      resource_parents: demoResourceParents(),
      types: {
        'fs.read_error': {
          kind: 'error-sum',
          variants: [
            'not_found',
            'permission_denied',
            'outside_sandbox',
            'invalid_utf8',
            'io',
          ],
        },
      },
      members: {
        read_file: {
          access: ['read fs.file(path)'],
          params: [
            { name: 'path', primary: true, type: 'fs.path' },
            {
              default: 'text.encoding.utf8',
              name: 'encoding',
              type: 'text.encoding',
            },
          ],
          returns: 'result<text.utf8, fs.read_error>',
        },
      },
    },
    {
      identity: 'fs.write',
      revision: '0.1.0',
      resource_catalog: demoResourceCatalog(['fs.file', 'fs.storage']),
      resource_parents: demoResourceParents(),
      types: {
        'fs.write_error': {
          kind: 'error-sum',
          variants: [
            'parent_not_found',
            'permission_denied',
            'outside_sandbox',
            'no_space',
            'io',
          ],
        },
      },
      members: {
        write_file: {
          access: ['write fs.file(path)'],
          params: [
            { name: 'path', primary: true, type: 'fs.path' },
            { name: 'data', type: 'bytes' },
          ],
          returns: 'result<unit, fs.write_error>',
        },
      },
    },
    {
      identity: 'process.stdout',
      revision: '0.1.0',
      resource_catalog: demoResourceCatalog(['process.stdout']),
      types: {
        'io.write_error': {
          kind: 'error-sum',
          variants: ['broken_pipe', 'io'],
        },
      },
      members: {
        write: {
          access: ['write process.stdout'],
          params: [{ name: 'data', primary: true, type: 'text.utf8' }],
          returns: 'result<unit, io.write_error>',
        },
      },
    },
  ]
}
