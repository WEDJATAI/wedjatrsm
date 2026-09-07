'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Eye, EyeOff, MoreHorizontal, Pencil, Plus, TriangleAlert, UsersRound } from 'lucide-react'

import { apiFetch, fetcher } from '@/lib/api'
import { ROLES } from '@/lib/constants'
import { formatDate } from '@/lib/format'
import type { CustomRole, SessionUser } from '@/lib/types'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// ─── Types & helpers ────────────────────────────────────────────────

type AdminUser = {
  id: number
  email: string
  name: string
  role: string
  roleId: number | null
  roleName: string | null
  pin: string | null
  active: boolean
  createdAt: string
}

type UserForm = {
  name: string
  email: string
  password: string
  role: string
  roleId: string // '' = none (only meaningful when role === 'custom')
  pin: string
}

type UserFormErrors = Partial<Record<'name' | 'email' | 'password' | 'role' | 'pin', string>>

const BUILTIN_ROLES = ROLES.filter((role) => role !== 'custom')

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PIN_RE = /^\d{6}$/ // PINs are exactly 6 digits (round 3 contract)

const EMPTY_USER_FORM: UserForm = {
  name: '',
  email: '',
  password: '',
  role: 'waiter',
  roleId: '',
  pin: '',
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

const ROLE_BADGE_CLASS: Record<string, string> = {
  admin: 'border-primary/40 bg-primary/10 text-primary',
  waiter:
    'border-emerald-600/40 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-400',
  kitchen:
    'border-rose-600/40 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-400',
  custom:
    'border-amber-600/40 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400',
}

const ROLE_AVATAR_CLASS: Record<string, string> = {
  admin: 'bg-primary/15 text-primary',
  waiter: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400',
  kitchen: 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400',
  custom: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-400',
}

/** Encoded Select value: 'custom:<roleId>' for custom roles, else the role name. */
function roleValue(role: string, roleId: string): string {
  return role === 'custom' ? `custom:${roleId}` : role
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <p className="text-destructive text-xs">{message}</p>
}

// ─── View ───────────────────────────────────────────────────────────

export default function UsersView() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<AdminUser | null>(null)
  const [form, setForm] = useState<UserForm>(EMPTY_USER_FORM)
  const [showPinId, setShowPinId] = useState<number | null>(null)

  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: () => fetcher<{ users: AdminUser[] }>('/api/users'),
  })

  // Custom roles for the role Select (active only; the editing user's own
  // role is always offered as a fallback even when inactive).
  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: () => fetcher<{ roles: CustomRole[] }>('/api/roles'),
  })

  // Used to guard self-deactivation in the UI (server enforces it too).
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => fetcher<{ user: SessionUser }>('/api/auth/me'),
    retry: false,
  })

  const currentUserId = meQuery.data?.user.id ?? null

  const users = useMemo(
    () => [...(usersQuery.data?.users ?? [])].sort((a, b) => a.id - b.id),
    [usersQuery.data],
  )

  const customRoles = useMemo(() => {
    const active = (rolesQuery.data?.roles ?? []).filter((r) => r.active)
    const ids = new Set(active.map((r) => r.id))
    // keep the currently-edited user's role selectable even if inactive
    if (editing?.roleId != null && !ids.has(editing.roleId)) {
      const stale = (rolesQuery.data?.roles ?? []).find((r) => r.id === editing.roleId)
      if (stale) return [...active, stale]
    }
    return active
  }, [rolesQuery.data, editing])

  const isCreate = editing === null

  function validateForm(): UserFormErrors {
    const errors: UserFormErrors = {}
    if (form.name.trim() === '') errors.name = t('admin.nameRequired')
    if (isCreate) {
      if (form.email.trim() === '') errors.email = t('admin.emailRequired')
      else if (!EMAIL_RE.test(form.email.trim())) errors.email = t('admin.emailInvalid')
      if (form.password.length < 4) errors.password = t('admin.passwordMin')
    }
    if (!ROLES.includes(form.role as (typeof ROLES)[number])) errors.role = t('admin.chooseRole')
    if (form.role === 'custom' && form.roleId === '') errors.role = t('admin.chooseRole')
    if (form.pin.trim() !== '' && !PIN_RE.test(form.pin.trim())) {
      errors.pin = t('admin.pinDigits')
    }
    return errors
  }

  const errors = validateForm()
  const hasErrors = Object.values(errors).some(Boolean)

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        role: form.role,
      }
      // roleId is ONLY accepted alongside role 'custom' (400 otherwise).
      if (form.role === 'custom' && form.roleId !== '') {
        payload.roleId = Number(form.roleId)
      }
      if (form.pin.trim() !== '') payload.pin = form.pin.trim()
      if (editing === null) {
        return apiFetch<{ user: SessionUser }>('/api/users', { method: 'POST', body: payload })
      }
      return apiFetch<{ user: SessionUser }>(`/api/users/${editing.id}`, {
        method: 'PUT',
        body: payload,
      })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      toast.success(editing === null ? t('admin.userCreated') : t('admin.userUpdated'))
      setFormOpen(false)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      apiFetch<{ user: SessionUser }>(`/api/users/${id}`, { method: 'PUT', body: { active } }),
    onMutate: async ({ id, active }) => {
      await queryClient.cancelQueries({ queryKey: ['users'] })
      const prev = queryClient.getQueryData<{ users: AdminUser[] }>(['users'])
      if (prev) {
        queryClient.setQueryData(['users'], {
          users: prev.users.map((u) => (u.id === id ? { ...u, active } : u)),
        })
      }
      return { prev }
    },
    onSuccess: (_data, vars) => {
      toast.success(vars.active ? t('admin.userActivated') : t('admin.userDeactivated'))
    },
    onError: (err: Error, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['users'], ctx.prev)
      toast.error(err.message)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] })
    },
  })

  function openCreate() {
    setEditing(null)
    setForm(EMPTY_USER_FORM)
    setFormOpen(true)
  }

  function openEdit(user: AdminUser) {
    setEditing(user)
    setForm({
      name: user.name,
      email: user.email,
      password: '',
      role: user.role,
      roleId: user.roleId != null ? String(user.roleId) : '',
      pin: user.pin ?? '',
    })
    setFormOpen(true)
  }

  function togglePin(id: number) {
    setShowPinId((prev) => (prev === id ? null : id))
  }

  const roleHeaders = { User: t('admin.user'), Role: t('common.role') }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">{t('nav.users')}</h1>
          <p className="text-muted-foreground text-sm">{t('admin.usersSubtitle')}</p>
        </div>
        <Button className="h-11" onClick={openCreate}>
          <Plus /> {t('admin.newUser')}
        </Button>
      </div>

      {/* Users table */}
      <Card className="p-4">
        {usersQuery.isLoading ? (
          <div className="space-y-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{roleHeaders.User}</TableHead>
                  <TableHead>{roleHeaders.Role}</TableHead>
                  <TableHead className="hidden md:table-cell">{t('admin.pinLabel')}</TableHead>
                  <TableHead>{t('common.status')}</TableHead>
                  <TableHead className="hidden md:table-cell">{t('admin.created')}</TableHead>
                  <TableHead className="w-12 text-end">
                    <span className="sr-only">{t('common.actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Array.from({ length: 4 }, (_, i) => (
                  <TableRow key={i} className="h-16">
                    <TableCell colSpan={6}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : usersQuery.isError ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <TriangleAlert className="size-10 text-destructive" aria-hidden />
            <div>
              <p className="font-medium">{t('admin.loadUsersFailed')}</p>
              <p className="text-muted-foreground text-sm">
                {usersQuery.error?.message ?? t('common.error')}
              </p>
            </div>
            <Button variant="outline" className="h-11" onClick={() => void usersQuery.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : users.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <UsersRound className="size-10 text-muted-foreground/50" aria-hidden />
            <div>
              <p className="font-medium">{t('admin.noUsers')}</p>
              <p className="text-muted-foreground text-sm">{t('admin.noUsersHint')}</p>
            </div>
            <Button className="h-11" onClick={openCreate}>
              <Plus /> {t('admin.newUser')}
            </Button>
          </div>
        ) : (
          <div className="rms-scroll max-h-[520px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{roleHeaders.User}</TableHead>
                  <TableHead>{roleHeaders.Role}</TableHead>
                  <TableHead className="hidden md:table-cell">{t('admin.pinLabel')}</TableHead>
                  <TableHead>{t('common.status')}</TableHead>
                  <TableHead className="hidden md:table-cell">{t('admin.created')}</TableHead>
                  <TableHead className="w-12 text-end">
                    <span className="sr-only">{t('common.actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => {
                  const isSelf = currentUserId === u.id
                  const roleLabel =
                    u.role === 'custom' ? (u.roleName ?? t('role.custom')) : t(`role.${u.role}`)
                  return (
                    <TableRow key={u.id} className="h-16">
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Avatar className="size-9">
                            <AvatarFallback
                              className={cn(
                                'text-xs font-semibold',
                                ROLE_AVATAR_CLASS[u.role] ?? ROLE_AVATAR_CLASS.custom,
                              )}
                            >
                              {initials(u.name)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <div className="font-medium">
                              {u.name}
                              {isSelf ? (
                                <span className="text-muted-foreground text-xs"> {t('admin.youTag')}</span>
                              ) : null}
                            </div>
                            <div className="text-muted-foreground text-xs">{u.email}</div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={cn(ROLE_BADGE_CLASS[u.role] ?? undefined)}
                        >
                          {roleLabel}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {u.pin ? (
                          <div className="flex items-center gap-1">
                            <span className="font-mono text-sm tracking-widest">
                              {showPinId === u.id ? u.pin : '••••••'}
                            </span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-11 text-muted-foreground"
                              onClick={() => togglePin(u.id)}
                              aria-label={
                                showPinId === u.id
                                  ? t('admin.hidePinAria', { name: u.name })
                                  : t('admin.showPinAria', { name: u.name })
                              }
                            >
                              {showPinId === u.id ? <EyeOff /> : <Eye />}
                            </Button>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {isSelf ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex">
                                <Switch
                                  checked={u.active}
                                  disabled
                                  aria-label={t('admin.selfDeactivateAria')}
                                />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>{t('admin.selfDeactivateHint')}</TooltipContent>
                          </Tooltip>
                        ) : (
                          <Switch
                            checked={u.active}
                            disabled={toggleMutation.isPending && toggleMutation.variables?.id === u.id}
                            onCheckedChange={(checked) =>
                              toggleMutation.mutate({ id: u.id, active: checked })
                            }
                            aria-label={
                              u.active
                                ? t('admin.deactivate') + ' ' + u.name
                                : t('admin.activate') + ' ' + u.name
                            }
                          />
                        )}
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground md:table-cell">
                        {formatDate(u.createdAt)}
                      </TableCell>
                      <TableCell className="text-end">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-11 text-muted-foreground"
                              aria-label={t('admin.actionsFor', { name: u.name })}
                            >
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openEdit(u)}>
                              <Pencil /> {t('common.edit')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      {/* Create / edit dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{isCreate ? t('admin.newUser') : t('admin.editUser')}</DialogTitle>
            <DialogDescription>
              {isCreate
                ? t('admin.userDialogCreateDesc')
                : t('admin.userDialogEditDesc', { name: editing?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="user-name">
                {t('common.name')} *
              </Label>
              <Input
                id="user-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t('admin.namePlaceholder')}
                className="h-11"
                aria-invalid={errors.name ? true : undefined}
              />
              <FieldError message={errors.name} />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="user-email">{t('common.email')}</Label>
              <Input
                id="user-email"
                type="email"
                inputMode="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="name@rms.com"
                className="h-11"
                disabled={!isCreate}
                aria-invalid={errors.email ? true : undefined}
              />
              {!isCreate && (
                <p className="text-muted-foreground text-xs">{t('admin.emailImmutable')}</p>
              )}
              <FieldError message={errors.email} />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="user-password">
                {t('common.password')}
                {isCreate ? ' *' : ''}
              </Label>
              <Input
                id="user-password"
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder={isCreate ? t('admin.passwordPlaceholder') : '••••'}
                className="h-11"
                aria-invalid={errors.password ? true : undefined}
              />
              <p className="text-muted-foreground text-xs">
                {isCreate ? t('admin.passwordCreateHint') : t('admin.passwordEditHint')}
              </p>
              <FieldError message={errors.password} />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="user-role">
                {t('common.role')} *
              </Label>
              <Select
                value={roleValue(form.role, form.roleId)}
                onValueChange={(value) => {
                  if (value.startsWith('custom:')) {
                    setForm({ ...form, role: 'custom', roleId: value.slice('custom:'.length) })
                  } else {
                    setForm({ ...form, role: value, roleId: '' })
                  }
                }}
              >
                <SelectTrigger id="user-role" className="h-11 w-full">
                  <SelectValue placeholder={t('admin.chooseRole')} />
                </SelectTrigger>
                <SelectContent>
                  {BUILTIN_ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      {t(`role.${role}`)}
                    </SelectItem>
                  ))}
                  {customRoles.map((r) => (
                    <SelectItem key={`custom-${r.id}`} value={`custom:${r.id}`}>
                      {r.name}
                      {!r.active ? ` ${t('admin.inactiveSuffix')}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError message={errors.role} />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="user-pin">{t('admin.pinLabel')}</Label>
              <Input
                id="user-pin"
                inputMode="numeric"
                maxLength={6}
                value={form.pin}
                onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/[^\d]/g, '') })}
                placeholder="123456"
                className="h-11 font-mono tracking-widest"
                aria-invalid={errors.pin ? true : undefined}
              />
              <p className="text-muted-foreground text-xs">{t('admin.pinHint')}</p>
              <FieldError message={errors.pin} />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              className="h-11"
              onClick={() => setFormOpen(false)}
              disabled={saveMutation.isPending}
            >
              {t('common.cancel')}
            </Button>
            <Button
              className="h-11"
              disabled={saveMutation.isPending || hasErrors}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? t('admin.saving') : isCreate ? t('admin.createUser') : t('admin.saveChanges')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
