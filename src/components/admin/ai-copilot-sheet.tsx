'use client'

// 9-b: manager AI copilot chat sheet (admin only — the parent gates it on
// the session role; the API 403s otherwise and errors surface gracefully).
// POST /api/ai/copilot with the last 10 messages of the local thread;
// assistant replies append to it. Bottom sheet on mobile, right side sheet
// on sm+ (useIsMobile picks the side before the sheet opens).

import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Loader2, Send, Sparkles } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { aiProviderLabel } from './ai-briefing-card'

type ChatMessage = { role: 'user' | 'assistant'; content: string }

type CopilotResponse = { reply: string; provider: string }

type AiCopilotSheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const MAX_HISTORY = 10 // backend keeps the last 10 messages

export default function AiCopilotSheet({ open, onOpenChange }: AiCopilotSheetProps) {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [lastProvider, setLastProvider] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const sendMutation = useMutation({
    mutationFn: (history: ChatMessage[]) =>
      apiFetch<CopilotResponse>('/api/ai/copilot', {
        body: { messages: history.slice(-MAX_HISTORY) },
      }),
    onSuccess: (data) => {
      setLastProvider(data.provider)
      setMessages((prev) => [...prev, { role: 'assistant', content: data.reply }])
    },
    onError: (err) => {
      // 503 (providers down) / 403 (role) / network — inline retry row below
      // plus this toast; the user message stays in the thread.
      toast.error(err instanceof Error && err.message ? err.message : t('ai.copilotError'))
    },
  })

  const send = (raw: string) => {
    const content = raw.trim()
    if (!content || sendMutation.isPending) return
    const next: ChatMessage[] = [...messages, { role: 'user', content }]
    setMessages(next)
    setInput('')
    sendMutation.mutate(next)
  }

  // Keep the thread pinned to the newest message (DOM-only effect).
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, sendMutation.isPending, open])

  const suggestions = [
    t('ai.copilotSuggest1'),
    t('ai.copilotSuggest2'),
    t('ai.copilotSuggest3'),
    t('ai.copilotSuggest4'),
  ]

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? 'bottom' : 'right'}
        className="flex h-[88dvh] w-full flex-col gap-0 overflow-hidden rounded-t-2xl sm:h-full sm:max-w-[28rem] sm:rounded-none sm:rounded-l-2xl"
      >
        <SheetHeader className="shrink-0 gap-2 border-b border-[#E2E2E0] p-4 pb-3">
          <div className="flex items-center justify-between gap-2 pe-10">
            <SheetTitle className="flex items-center gap-2 text-lg">
              <Sparkles className="size-5 text-amber-600" aria-hidden />
              {t('ai.copilotTitle')}
            </SheetTitle>
            {lastProvider && (
              <Badge variant="secondary" className="shrink-0 font-medium">
                {aiProviderLabel(lastProvider, t('ai.providerZai'))}
              </Badge>
            )}
          </div>
          <SheetDescription>{t('ai.copilotSubtitle')}</SheetDescription>
        </SheetHeader>

        {/* Thread */}
        <div
          ref={scrollRef}
          role="log"
          aria-live="polite"
          aria-label={t('ai.copilotTitle')}
          className="rms-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
        >
          {messages.length === 0 && !sendMutation.isPending ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 py-8 text-center">
              <div className="grid size-14 place-items-center rounded-2xl bg-amber-100">
                <Sparkles className="size-7 text-amber-600" aria-hidden />
              </div>
              <p className="max-w-[30ch] text-sm text-muted-foreground">{t('ai.copilotSubtitle')}</p>
              <div className="flex flex-wrap justify-center gap-2">
                {suggestions.map((s) => (
                  <Button
                    key={s}
                    type="button"
                    variant="outline"
                    onClick={() => send(s)}
                    className="h-11 rounded-full border-[#E2E2E0] bg-white px-4 text-sm font-medium hover:border-amber-400 hover:bg-amber-50 hover:text-amber-800"
                  >
                    {s}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={cn('flex w-full', m.role === 'user' ? 'justify-end' : 'justify-start')}
                >
                  <div
                    className={cn(
                      'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
                      m.role === 'user'
                        ? 'rounded-ee-md bg-amber-500 text-amber-950'
                        : 'rounded-es-md border border-[#E2E2E0] bg-white text-stone-700 shadow-sm',
                    )}
                  >
                    {m.content}
                  </div>
                </div>
              ))}

              {sendMutation.isPending && (
                <div className="flex w-full justify-start">
                  <div
                    className="flex items-center gap-1.5 rounded-2xl rounded-es-md border border-[#E2E2E0] bg-white px-4 py-3.5 shadow-sm"
                    aria-label={t('ai.copilotThinking')}
                  >
                    <span className="sr-only">{t('ai.copilotThinking')}</span>
                    {[0, 1, 2].map((d) => (
                      <span
                        key={d}
                        className="size-2 animate-bounce rounded-full bg-amber-500/70"
                        style={{ animationDelay: `${d * 140}ms` }}
                        aria-hidden
                      />
                    ))}
                  </div>
                </div>
              )}

              {sendMutation.isError && (
                <div className="flex items-center justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2">
                  <p className="min-w-0 flex-1 text-xs text-rose-700">{t('ai.copilotError')}</p>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-9 shrink-0 rounded-lg px-2 text-xs font-semibold text-rose-700 hover:bg-rose-100 hover:text-rose-800"
                    onClick={() => sendMutation.mutate(messages.slice(-MAX_HISTORY))}
                  >
                    {t('ai.briefingRetry')}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Input row */}
        <form
          className="shrink-0 border-t border-[#E2E2E0] p-3 sm:p-4"
          onSubmit={(e) => {
            e.preventDefault()
            send(input)
          }}
        >
          <div className="flex items-center gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('ai.copilotPlaceholder')}
              aria-label={t('ai.copilotTitle')}
              className="h-11 rounded-xl border-[#E2E2E0] bg-white text-base"
              inputMode="text"
              maxLength={2000}
              autoComplete="off"
            />
            <Button
              type="submit"
              disabled={!input.trim() || sendMutation.isPending}
              aria-label={t('ai.copilotSend')}
              title={t('ai.copilotSend')}
              className="h-11 w-11 shrink-0 rounded-xl px-0"
            >
              {sendMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Send className="size-4" aria-hidden />
              )}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
