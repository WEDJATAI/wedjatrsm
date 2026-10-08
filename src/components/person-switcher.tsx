'use client'

// R19 — navbar person switcher. Shows WHO is operating the account right now
// (actual staff member) and lets staff hand the device over mid-shift with
// one tap. Hidden entirely for accounts with no registered people.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { UserRound } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { apiFetch, fetcher, setSessionToken } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import type { SessionUser } from '@/lib/types'
import { cn } from '@/lib/utils'

type PeopleResponse = {
  people: { id: number; name: string }[]
  personId: number | null
  personName: string | null
}

export function PersonSwitcher({ user }: { user: SessionUser }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data } = useQuery({
    queryKey: ['session-people'],
    queryFn: () => fetcher<PeopleResponse>('/api/auth/person'),
    staleTime: 60_000,
  })

  const people = data?.people ?? []
  if (people.length === 0) return null

  const currentPersonId = user.personId ?? data?.personId ?? null
  const currentName = user.personName ?? data?.personName ?? null

  const switchTo = async (personId: number | null) => {
    try {
      const { token } = await apiFetch<{ token?: string }>('/api/auth/person', {
        body: { personId },
      })
      if (token) setSessionToken(token)
      // refresh the session (navbar chip + POS attribution) and the roster
      await queryClient.invalidateQueries({ queryKey: ['session'] })
      await queryClient.invalidateQueries({ queryKey: ['session-people'] })
      toast.success(t('nav.personSwitched'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('error.generic'))
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          aria-label={t('nav.switchPerson')}
          title={t('nav.switchPerson')}
          className="h-11 shrink-0 gap-1.5 px-3 text-white/70 hover:bg-white/10 hover:text-white focus-visible:ring-white/60"
        >
          <UserRound className="h-5 w-5" aria-hidden />
          {currentName ? (
            <span className="max-w-[110px] truncate text-sm font-medium">{currentName}</span>
          ) : (
            <span className="max-w-[110px] truncate text-xs text-white/60">
              {t('nav.noPersonSelected')}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>{t('nav.switchPersonTitle')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {people.map((person) => (
          <DropdownMenuItem
            key={person.id}
            onClick={() => void switchTo(person.id)}
            aria-checked={person.id === currentPersonId}
            className={cn('min-h-10', person.id === currentPersonId && 'font-semibold')}
          >
            <span className="bg-primary/10 text-primary grid h-6 w-6 place-items-center rounded-full text-[10px] font-bold" aria-hidden>
              {person.name.trim().charAt(0).toUpperCase()}
            </span>
            <span className="flex-1 truncate">{person.name}</span>
            {person.id === currentPersonId && (
              <span className="text-primary text-xs font-semibold">{t('nav.currentPerson')}</span>
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void switchTo(null)} className="min-h-10">
          <span className="text-muted-foreground flex-1 truncate">
            {t('nav.accountLevel', { name: user.name })}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
