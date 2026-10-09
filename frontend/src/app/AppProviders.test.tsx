import { QueryClient, useQueryClient } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { useTheme } from 'styled-components'
import { describe, expect, it } from 'vitest'
import { theme } from '../design-system'
import { queryClient } from '../lib/queryClient'
import { AppProviders } from './AppProviders'

let seenClient: QueryClient | undefined
let seenTheme: unknown

function Probe() {
  seenClient = useQueryClient()
  seenTheme = useTheme()
  return <p>Child content</p>
}

describe('AppProviders', () => {
  it('renders its children with the given query client and the app theme', () => {
    const client = new QueryClient()
    render(
      <AppProviders client={client}>
        <Probe />
      </AppProviders>,
    )
    expect(screen.getByText('Child content')).toBeVisible()
    expect(seenClient).toBe(client)
    expect(seenTheme).toBe(theme)
  })

  it('uses the shared application query client by default', () => {
    render(
      <AppProviders>
        <Probe />
      </AppProviders>,
    )
    expect(seenClient).toBe(queryClient)
  })
})
