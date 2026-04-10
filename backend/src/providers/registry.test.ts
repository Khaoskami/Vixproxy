import { describe, it, expect } from 'vitest'
import { resolveModel } from './registry.js'

describe('resolveModel', () => {
  it('resolves explicit provider prefix', () => {
    expect(resolveModel('anthropic/claude-sonnet-4-5')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    })
    expect(resolveModel('openai/gpt-4o')).toEqual({ provider: 'openai', model: 'gpt-4o' })
  })

  it('resolves gpt-* to openai', () => {
    expect(resolveModel('gpt-4o-mini').provider).toBe('openai')
    expect(resolveModel('gpt-4-turbo').provider).toBe('openai')
  })

  it('resolves o1 and o3 reasoning models to openai', () => {
    expect(resolveModel('o1-preview').provider).toBe('openai')
    expect(resolveModel('o3-mini').provider).toBe('openai')
  })

  it('resolves claude-* to anthropic', () => {
    expect(resolveModel('claude-opus-4-6').provider).toBe('anthropic')
    expect(resolveModel('claude-3-5-sonnet-latest').provider).toBe('anthropic')
  })

  it('resolves gemini-* to gemini', () => {
    expect(resolveModel('gemini-1.5-pro').provider).toBe('gemini')
  })

  it('resolves deepseek-* to deepseek', () => {
    expect(resolveModel('deepseek-chat').provider).toBe('deepseek')
    expect(resolveModel('deepseek-reasoner').provider).toBe('deepseek')
  })

  it('resolves llama/mixtral to groq', () => {
    expect(resolveModel('llama-3.3-70b-versatile').provider).toBe('groq')
    expect(resolveModel('mixtral-8x7b-32768').provider).toBe('groq')
  })

  it('resolves command-* to cohere', () => {
    expect(resolveModel('command-r-plus').provider).toBe('cohere')
  })

  it('resolves mistral-* to mistral', () => {
    expect(resolveModel('mistral-large-latest').provider).toBe('mistral')
  })

  it('falls back to openrouter for unknown vendor/model', () => {
    expect(resolveModel('some-vendor/weird-model').provider).toBe('openrouter')
  })

  it('throws for unknown flat models', () => {
    expect(() => resolveModel('totallymadeup')).toThrow(/Unknown model/)
  })
})
