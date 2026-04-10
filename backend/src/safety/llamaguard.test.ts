import { describe, it, expect } from 'vitest'
import { parseLlamaGuardResponse } from './llamaguard.js'

describe('parseLlamaGuardResponse', () => {
  it('parses safe response', () => {
    const d = parseLlamaGuardResponse('safe')
    expect(d.allowed).toBe(true)
  })

  it('parses unsafe with single category', () => {
    const d = parseLlamaGuardResponse('unsafe\nS4')
    expect(d.allowed).toBe(false)
    expect(d.categories).toContain('Child Sexual Exploitation')
  })

  it('parses unsafe with multiple categories', () => {
    const d = parseLlamaGuardResponse('unsafe\nS1,S4')
    expect(d.allowed).toBe(false)
    expect(d.categories).toContain('Violent Crimes')
    expect(d.categories).toContain('Child Sexual Exploitation')
  })

  it('handles unknown codes', () => {
    const d = parseLlamaGuardResponse('unsafe\nS99')
    expect(d.allowed).toBe(false)
    expect(d.categories).toContain('S99')
  })

  it('fail-opens on unknown format', () => {
    const d = parseLlamaGuardResponse('i am confused')
    expect(d.allowed).toBe(true)
  })
})
