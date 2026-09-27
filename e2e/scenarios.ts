import type { Repo, RepoRef } from '../src/github/types'
import type { ApiCall } from './github'
import { NEW_TOKEN, TOKEN } from './seed'

/**
 * Builders and readers more than one spec needs. Each spec keeps its own
 * story; what is here is only the vocabulary they share.
 */

/** Every run listing, of any repository and either status. */
export const LISTINGS = /\/actions\/runs\?status=/

/** The repository list setup asks for, exactly as src/github/api.ts spells it. */
export const REPOS_PATH = '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member'

/** A repository as GET /user/repos lists it. */
export function repo(fullName: string, over: Partial<Repo> = {}): Repo {
  const { owner, name } = ref(fullName)
  return {
    full_name: fullName,
    owner: { login: owner },
    name,
    private: false,
    pushed_at: '2026-09-09T09:00:00Z',
    archived: false,
    ...over,
  }
}

export function ref(fullName: string): RepoRef {
  const [owner, name] = fullName.split('/') as [string, string]
  return { owner, name }
}

/** Names a credential without repeating it, so a failure message never prints a token. */
export function credential(value: unknown): string {
  if (value === TOKEN) return 'TOKEN'
  if (value === NEW_TOKEN) return 'NEW_TOKEN'
  return value === null || value === undefined ? String(value) : 'something else'
}

/** Which test token a call carried, by name. */
export function bearer(call: ApiCall): string {
  const header = call.headers.authorization
  return header?.startsWith('Bearer ') ? credential(header.slice('Bearer '.length)) : credential(header)
}

/** Calls as "METHOD /path?query", for comparing the order of requests. */
export function requests(calls: readonly ApiCall[]): string[] {
  return calls.map((c) => `${c.method} ${c.path}`)
}
