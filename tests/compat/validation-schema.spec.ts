import { Context } from '@deepseek-ai/cordis'
import Storage, { type KvUnit, type StorageBackend } from '@deepseek-ai/dsh-storage'
import { defineDomain, DomainFacility, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { officialValidationSchema } from '../../src/compat/host/validation-schema.ts'

type Medium = Awaited<ReturnType<KvUnit['loadAll']>>

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function fixture(medium: Medium) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend: StorageBackend = {
    close: async () => {},
    kv: {
      async open() {
        let closed = false
        return {
          loadAll: async () => structuredClone(medium),
          putRecord: async (table, key, value) => {
            if (closed) throw new Error('closed')
            medium.tables[table] ??= {}
            medium.tables[table]![key] = value
          },
          deleteRecord: async (table, key) => {
            delete medium.tables[table]?.[key]
          },
          deleteRecords: async (table, keys) => {
            for (const key of keys) delete medium.tables[table]?.[key]
          },
          setGlobal: async (global) => {
            medium.global = global
          },
          close: async () => {
            closed = true
          },
        }
      },
    },
  }
  ctx.storage.backend.register('fixture', backend)
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  cleanups.push(async () => {
    await facility.closeAll()
    await ctx.fiber.dispose()
  })
  return facility
}

function spec() {
  const recordSchema = officialValidationSchema(
    z
      .object({
        text: z.string().transform((value) => value.toUpperCase()),
        retries: z.number().default(1),
      })
      .strict()
      .refine((record) => record.text !== 'BAD', 'rejected record'),
  )
  return defineDomain({
    name: 'validation_bridge',
    version: 1,
    global: {
      schema: officialValidationSchema(
        z.object({
          count: z.union([z.string(), z.number()]).transform(Number),
          label: z.string().default('loaded'),
        }),
      ),
      initial: { count: 0, label: 'initial' },
    },
    tables: { records: domainTable<string, { text: string; retries: number }>(recordSchema) },
  })
}

describe('Zod minor-version compatibility bridge', () => {
  it('keeps transformed and defaulted values returned by the official domain loader', async () => {
    const medium: Medium = {
      tables: { records: { seed: { text: 'hello' } } },
      global: { count: '4' },
    }
    const facility = await fixture(medium)
    const domain = await facility.open(spec())

    expect(domain.table('records').get('seed')).toEqual({ text: 'HELLO', retries: 1 })
    expect(domain.global.get()).toEqual({ count: 4, label: 'loaded' })
    expect(medium.tables.records?.seed).toEqual({ text: 'hello' })
    expect(medium.global).toEqual({ count: '4' })

    await domain.table('records').put('seed', domain.table('records').get('seed')!)
    await domain.global.set(domain.global.get())
    await domain.close()
    const reopened = await facility.open(spec())
    expect(reopened.table('records').get('seed')).toEqual({ text: 'HELLO', retries: 1 })
    expect(reopened.global.get()).toEqual({ count: 4, label: 'loaded' })
  })

  it.each([
    { check: 'strict', record: { text: 'hello', extra: true }, code: 'unrecognized_keys' },
    { check: 'refine', record: { text: 'bad' }, code: 'custom' },
  ])('rejects a $check failure at the official durable boundary', async ({ record, code }) => {
    const medium: Medium = {
      tables: { records: { invalid: record } },
      global: null,
    }
    const facility = await fixture(medium)

    await expect(facility.open(spec())).rejects.toMatchObject({
      code: 'invalid-record',
      detail: { table: 'records', key: 'invalid' },
      cause: { issues: expect.arrayContaining([expect.objectContaining({ code })]) },
    })
  })

  it('rejects a nullable global schema because null is the official absence sentinel', () => {
    expect(() =>
      defineDomain({
        name: 'validation_nullable',
        version: 1,
        global: {
          schema: officialValidationSchema(z.string().nullable()),
          initial: null,
        },
        tables: {},
      }),
    ).toThrow('must not accept null')
  })
})
