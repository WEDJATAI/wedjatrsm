'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Eye, EyeOff, MoreHorizontal, Pencil, Plus, TriangleAlert, UsersRound } from 'lucide-react'

import { apiFetch, fetcher } from '@/lib/api'
import { ROLE_LABELS, ROLES } from '@/lib/constants'
import { formatDate } from '@/lib/format'
import type { SessionUser } from '@/lib/types'
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
  pin: string | null
  active: boolean
  createdAt: string
}

type UserForm = {
  name: string
  email: string
  password: string
  role: string
  pin: string
}

type UserFormErrors = Partial<Record<'name' | 'email' | 'password' | 'role' | 'pin', string>>

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PIN_RE = /^\d{4}$/

const EMPTY_USER_FORM: UserForm = {
  name: '',
  email: '',
  password: '',
  role: 'waiter',
  pin: '',
}

function validateUserForm(form: UserForm, isCreate: boolean): UserFormErrors {
  const errors: UserFormErrors = {}
  if (form.name.trim() === '') errors.name = 'Name is required'
  if (isCreate) {
    if (form.email.trim() === '') errors.email = 'Email is required'
    else if (!EMAIL_RE.test(form.email.trim())) errors.email = 'Enter a valid email address'
    if (form.password.length < 4) errors.password = 'Password must be at least 4 characters'
  }
  if (!ROLES.includes(form.role as (typeof ROLES)[number])) errors.role = 'Choose a role'
  if (form.pin.trim() !== '' && !PIN_RE.test(form.pin.trim())) {
    errors.pin = 'PIN must be exactly 4 digits'
  }
  return errors
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

const ROLE_BADGE_CLASS: Record<string, string> = {
  admin:
    'border-amber-600/40 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400',
  waiter:
    'border-emerald-600/40 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-400',
  kitchen:
    'border-rose-600/40 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-400',
}

const ROLE_AVATAR_CLASS: Record<string, string> = {
  admin: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-400',
  waiter: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400',
  kitchen: 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400',
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <p className="text-destructive text-xs">{message}</p>
}

// ─── View ───────────────────────────────────────────────────────────

export default function UsersView() {
  const queryClient = useQueryClient()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<AdminUser | null>(null)
  const [form, setForm] = useState<UserForm>(EMPTY_USER_FORM)
  const [showPinId, setShowPinId] = useState<number | null>(null)

  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: () => fetcher<{ users: AdminUser[] }>('/api/users'),
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

  const isCreate = editing === null
  const errors = validateUserForm(form, isCreate)
  const hasErrors = Object.values(errors).some(Boolean)

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (editing === null) {
        const payload: Record<string, unknown> = {
          name: form.name.trim(),
          email: form.email.trim(),
          password: form.password,
          role: form.role,
        }
        if (form.pin.trim() !== '') payload.pin = form.pin.trim()
        return apiFetch<{ user: SessionUser }>('/api/users', { method: 'POST', body: payload })
      }
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        role: form.role,
      }
      if (form.pin.trim() !== '') payload.pin = form.pin.trim()
      if (form.password !== '') payload.password = form.password
      return apiFetch<{ user: SessionUser }>(`/api/users/${editing.id}`, {
        method: 'PUT',
        body: payload,
      })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      toast.success(editing === null ? 'User created' : 'User updated')
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
      toast.success(vars.active ? 'User activated' : 'User deactivated')
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
      pin: user.pin ?? '',
    })
    setFormOpen(true)
  }

  function togglePin(id: number) {
    setShowPinId((prev) => (prev === id ? null : id))
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">Users</h1>
          <p className="text-muted-foreground text-sm">Staff accounts and roles</p>
        </div>
        <Button className="h-11" onClick={openCreate}>
          <Plus /> New User
        </Button>
      </div>

      {/* Users table */}
      <Card className="p-4">
        {usersQuery.isLoading ? (
          <div className="space-y-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="hidden md:table-cell">PIN</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Created</TableHead>
                  <TableHead className="w-12 text-right">
                    <span className="sr-only">Actions</span>
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
              <p className="font-medium">Failed to load users</p>
              <p className="text-muted-foreground text-sm">
                {usersQuery.error?.message ?? 'Please try again.'}
              </p>
            </div>
            <Button variant="outline" className="h-11" onClick={() => void usersQuery.refetch()}>
              Retry
            </Button>
          </div>
        ) : users.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <UsersRound className="size-10 text-muted-foreground/50" aria-hidden />
            <div>
              <p className="font-medium">No users yet</p>
              <p className="text-muted-foreground text-sm">
                Create staff accounts so your team can log in.
              </p>
            </div>
            <Button className="h-11" onClick={openCreate}>
              <Plus /> New User
            </Button>
          </div>
        ) : (
          <div className="rms-scroll max-h-[520px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="hidden md:table-cell">PIN</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Created</TableHead>
                  <TableHead className="w-12 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => {
                  const isSelf = currentUserId === u.id
                  return (
                    <TableRow key={u.id} className="h-16">
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Avatar className="size-9">
                            <AvatarFallback
                              className={cn('text-xs font-semibold', ROLE_AVATAR_CLASS[u.role])}
                            >
                              {initials(u.name)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <div className="font-medium">
                              {u.name}
                              {isSelf ? <span className="text-muted-foreground text-xs"> (you)</span> : null}
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
                          {ROLE_LABELS[u.role] ?? u.role}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {u.pin ? (
                          <div className="flex items-center gap-1">
                            <span className="font-mono text-sm tracking-widest">
                              {showPinId === u.id ? u.pin : '••••'}
                            </span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-11 text-muted-foreground"
                              onClick={() => togglePin(u.id)}
                              aria-label={showPinId === u.id ? `Hide PIN of ${u.name}` : `Show PIN of ${u.name}`}
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
                                  aria-label="You cannot deactivate your own account"
                                />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>You can&apos;t deactivate your own account</TooltipContent>
                          </Tooltip>
                        ) : (
                          <Switch
                            checked={u.active}
                            disabled={toggleMutation.isPending && toggleMutation.variables?.id === u.id}
                            onCheckedChange={(checked) =>
                              toggleMutation.mutate({ id: u.id, active: checked })
                            }
                            aria-label={`${u.active ? 'Deactivate' : 'Activate'} ${u.name}`}
                          />
                        )}
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground md:table-cell">
                        {formatDate(u.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-11 text-muted-foreground"
                              aria-label={`Actions for ${u.name}`}
                            >
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openEdit(u)}>
                              <Pencil /> Edit
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
            <DialogTitle>{isCreate ? 'New User' : 'Edit User'}</DialogTitle>
            <DialogDescription>
              {isCreate
                ? 'Create a staff account with a role and optional PIN.'
                : `Update ${editing?.name ?? 'user'} details.`}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="user-name">Name *</Label>
              <Input
                id="user-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Ahmed Hassan"
                className="h-11"
                aria-invalid={errors.name ? true : undefined}
              />
              <FieldError message={errors.name} />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="user-email">Email</Label>
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
                <p className="text-muted-foreground text-xs">Email cannot be changed.</p>
              )}
              <FieldError message={errors.email} />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="user-password">{isCreate ? 'Password *' : 'Password'}</Label>
              <Input
                id="user-password"
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder={isCreate ? 'Min. 4 characters' : '••••'}
                className="h-11"
                aria-invalid={errors.password ? true : undefined}
              />
              <p className="text-muted-foreground text-xs">
                {isCreate ? 'Used with email to log in.' : 'Leave blank to keep the current password.'}
              </p>
              <FieldError message={errors.password} />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="user-role">Role *</Label>
              <Select value={form.role} onValueChange={(role) => setForm({ ...form, role })}>
                <SelectTrigger id="user-role" className="h-11 w-full">
                  <SelectValue placeholder="Choose a role" />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError message={errors.role} />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="user-pin">PIN</Label>
              <Input
                id="user-pin"
                inputMode="numeric"
                maxLength={4}
                value={form.pin}
                onChange={(e) => setForm({ ...form, pin: e.target.value })}
                placeholder="1234"
                className="h-11 font-mono tracking-widest"
                aria-invalid={errors.pin ? true : undefined}
              />
              <p className="text-muted-foreground text-xs">4-digit quick login</p>
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
              Cancel
            </Button>
            <Button
              className="h-11"
              disabled={saveMutation.isPending || hasErrors}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? 'Saving…' : isCreate ? 'Create User' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
