import { type AgentChatScope, OmnaraClientProvider } from '@omnara/react'
import type { OmnaraClient } from '@omnara/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'ink'

import { Chat } from './chat-ui.tsx'
import { TernTerminal } from './tern/terminal.ts'

export async function runChat(client: OmnaraClient, scope: AgentChatScope): Promise<void> {
  const queryClient = new QueryClient()
  const terminal = new TernTerminal(process.stdin, process.stdout)
  const app = render(
    <QueryClientProvider client={queryClient}>
      <OmnaraClientProvider client={client}>
        <Chat scope={scope} terminal={terminal} />
      </OmnaraClientProvider>
    </QueryClientProvider>,
    { stdin: terminal.stdin as NodeJS.ReadStream },
  )
  try {
    await app.waitUntilExit()
  } finally {
    terminal.dispose()
    queryClient.clear()
  }
}
