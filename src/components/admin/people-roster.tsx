'use client'

// R19 — People roster (admin › Users). Shows, per ACCOUNT, the actual staff
// members who operate it, their activity stats (checks issued, item moves,
// units moved, attributed actions) and quick management: add, rename,
// activate/deactivate. Deletion is deliberately not offered — history
// (issued checks, audit rows) references persons, so they are deactivated
// instead, keeping every past attribution valid and readable.

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Pencil, UserRound, X } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { apiFetch, fetcher } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import type { Person } from '@/lib/types'
import { cn } from '@/lib/utils'

export type RosterUser = {
  id: number
  name: string
  email: string
  role: string
  roleName: string | null
  active: boolean
  people?: { id: number; name: string; active: boolean }[]
}

type PeopleReport = {
  groups: {
    userId: number
    people: (Person & { checks: number; moves: number; unitsMoved: number; transactions: number })[]
    totals: { checks: number; moves: number; unitsMoved: number; transactions: number }
  }[]
  byType: {
    type: string
    totalPeople: number
    checks: number
    moves: number
    unitsMoved: number
    transactions: number
  }[]
}

export function PeopleRoster({ users }: { users: RosterUser[] }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  // Per-person activity stats (30-day default window, server-side).
  const statsQuery = useQuery({
    queryKey: ['reports', 'people'],
    queryFn: () => fetcher<PeopleReport>('/api/reports/people'),
    staleTime: 30_000,
  })

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['users'] }),
      queryClient.invalidateQueries({ queryKey: ['reports', 'people'] }),
    ])
  }

  const addPerson = useMutation({
    mutationFn: (vars: { userId: number; name: string }) =>
      apiFetch(`/api/users/${vars.userId}/persons`, { body: { name: vars.name } }),
    onSuccess: (_data, vars) => {
      toast.success(t('admin.personCreated', { name: vars.name }))
      void invalidate()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const updatePerson = useMutation({
    mutationFn: (vars: { userId: number; personId: number; name?: string; active?: boolean }) =>
      apiFetch(`/api/users/${vars.userId}/persons/${vars.personId}`, { body: vars }),
    onSuccess: (_data, vars) => {
      toast.success(
        vars.active === false
          ? t('admin.personDeactivated')
          : vars.active === true
            ? t('admin.personReactivated')
            : t('admin.personUpdated'),
      )
      void invalidate()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // personId → stats lookup
  const statsByPerson = useMemo(() => {
    const map = new Map<number, PeopleReport['groups'][number]['people'][number]>()
    for (const group of statsQuery.data?.groups ?? []) {
      for (const person of group.people) map.set(person.id, person)
    }
    return map
  }, [statsQuery.data])

  const byType = statsQuery.data?.byType ?? []

  return (
    <Card className="p-4 sm:p-6">
      <div className="mb-4 space-y-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <UserRound className="size-5 text-primary" aria-hidden />
          {t('admin.peopleTitle')}
        </h2>
        <p className="text-muted-foreground text-sm">{t('admin.peopleHint')}</p>
      </div>

      {/* By user type — the §8 “User Type → people → activity” rollup */}
      {byType.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {byType.map((type) => (
            <Badge key={type.type} variant="outline" className="gap-1.5 py-1.5 text-xs">
              <span className="font-semibold">{type.type}</span>
              <span className="text-muted-foreground">
                {t('admin.peopleCount', { n: type.totalPeople })}
              </span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">
                {t('admin.personChecks')} {type.checks}
              </span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">
                {t('admin.personMoves')} {type.moves}
              </span>
            </Badge>
          ))}
        </div>
      )}

      <div className="space-y-4">
        {users.map((user) => (
          <AccountRoster
            key={user.id}
            user={user}
            statsByPerson={statsByPerson}
            addPerson={addPerson}
            updatePerson={updatePerson}
          />
        ))}
      </div>
    </Card>
  )
}

function AccountRoster({
  user,
  statsByPerson,
  addPerson,
  updatePerson,
}: {
  user: RosterUser
  statsByPerson: Map<number, PeopleReport['groups'][number]['people'][number]>
  addPerson: { mutate: (vars: { userId: number; name: string }) => void; isPending: boolean }
  updatePerson: {
    mutate: (vars: { userId: number; personId: number; name?: string; active?: boolean }) => void
    isPending: boolean
  }
}) {
  const { t } = useI18n()
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const people = user.people ?? []
  const activeCount = people.filter((p) => p.active).length

  const roleLabel = user.role === 'custom' ? (user.roleName ?? t('role.custom')) : t(`role.${user.role}`)

  const submitAdd = () => {
    const name = newName.trim()
    if (name.length < 2) {
      toast.error(t('admin.personNameRequired'))
      return
    }
    addPerson.mutate({ userId: user.id, name })
    setNewName('')
  }

  const submitRename = (personId: number) => {
    const name = renameValue.trim()
    if (name.length < 2) {
      toast.error(t('admin.personNameRequired'))
      return
    }
    updatePerson.mutate({ userId: user.id, personId, name })
    setRenamingId(null)
  }

  return (
    <div className="rounded-lg border">
      {/* Account header */}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2.5">
        <span className="text-sm font-semibold">{user.name}</span>
        <span className="text-muted-foreground hidden truncate text-xs sm:inline">{user.email}</span>
        <Badge variant="secondary" className="text-[10px]">
          {roleLabel}
        </Badge>
        {!user.active && (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            {t('admin.accountInactive')}
          </Badge>
        )}
        <span className="text-muted-foreground ms-auto text-xs">
          {t('admin.peopleCount', { n: activeCount })}
        </span>
      </div>

      {/* People rows */}
      {people.length === 0 ? (
        <p className="text-muted-foreground px-3 py-3 text-xs">
          {t('admin.noPeople')}
        </p>
      ) : (
        <ul className="divide-y">
          {people.map((person) => {
            const stats = statsByPerson.get(person.id)
            const renaming = renamingId === person.id
            return (
              <li key={person.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                {renaming ? (
                  <>
                    <Input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitRename(person.id)
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                      className="h-9 max-w-56"
                      aria-label={t('admin.personName')}
                    />
                    <Button size="icon" className="size-9" onClick={() => submitRename(person.id)} aria-label={t('common.save')}>
                      <Check className="size-4" />
                    </Button>
                    <Button size="icon" variant="outline" className="size-9" onClick={() => setRenamingId(null)} aria-label={t('common.cancel')}>
                      <X className="size-4" />
                    </Button>
                  </>
                ) : (
                  <>
                    <span
                      className={cn(
                        'bg-primary/10 text-primary grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold',
                        !person.active && 'opacity-40 grayscale',
                      )}
                      aria-hidden
                    >
                      {person.name.trim().charAt(0).toUpperCase()}
                    </span>
                    <span className={cn('text-sm font-medium', !person.active && 'text-muted-foreground line-through')}>
                      {person.name}
                    </span>
                    {!person.active && (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">
                        {t('admin.inactiveSuffix').trim()}
                      </Badge>
                    )}
                    {/* Activity stats (30d) */}
                    <span className="text-muted-foreground ms-auto flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs tabular-nums">
                      <span title={t('admin.personChecks')}>
                        {t('admin.personChecks')} <b>{stats?.checks ?? 0}</b>
                      </span>
                      <span title={t('admin.personMoves')}>
                        {t('admin.personMoves')} <b>{stats?.moves ?? 0}</b>
                      </span>
                      <span title={t('admin.personUnits')}>
                        {t('admin.personUnits')} <b>{stats?.unitsMoved ?? 0}</b>
                      </span>
                      <span title={t('admin.personTransactions')}>
                        {t('admin.personTransactions')} <b>{stats?.transactions ?? 0}</b>
                      </span>
                    </span>
                    <span className="flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 text-muted-foreground"
                        aria-label={t('common.edit')}
                        onClick={() => {
                          setRenamingId(person.id)
                          setRenameValue(person.name)
                        }}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8"
                        disabled={updatePerson.isPending}
                        onClick={() =>
                          updatePerson.mutate({ userId: user.id, personId: person.id, active: !person.active })
                        }
                      >
                        {person.active ? t('admin.personDeactivate') : t('admin.personReactivate')}
                      </Button>
                    </span>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {/* Add person */}
      <div className="flex items-center gap-2 border-t px-3 py-2.5">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitAdd()
          }}
          placeholder={t('admin.personNamePlaceholder')}
          className="h-9 max-w-56"
          aria-label={t('admin.addPerson')}
        />
        <Button
          size="sm"
          className="h-9"
          disabled={addPerson.isPending}
          onClick={submitAdd}
        >
          {t('admin.addPerson')}
        </Button>
      </div>
    </div>
  )
}
