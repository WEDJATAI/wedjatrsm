'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  BarChart3,
  BookOpen,
  Boxes,
  ChefHat,
  Clock,
  LayoutDashboard,
  Loader2,
  Map,
  Package,
  Pencil,
  Plus,
  Settings,
  ShieldCheck,
  Tags,
  TriangleAlert,
  UsersRound,
  Utensils,
  type LucideIcon,
} from 'lucide-react'

import { apiFetch, fetcher } from '@/lib/api'
import { PERMISSIONS } from '@/lib/constants'
import type { CustomRole } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'

// ─── Permission tick grid metadata ──────────────────────────────────
// Labels come from the shared nav.* keys; one-line descriptions are
// admin.permDesc.* (both EN + AR — all 13 modules covered).

const PERMISSION_ICONS: Record<string, LucideIcon> = {
  pos: Utensils,
  kitchen: ChefHat,
  dashboard: LayoutDashboard,
  products: Package,
  categories: Tags,
  floorplans: Map,
  inventory: Boxes,
  recipes: BookOpen,
  reports: BarChart3,
  users: UsersRound,
  roles: ShieldCheck,
  attendance: Clock,
  settings: Settings,
}

type RoleForm = {
  name: string
  permissions: string[]
}

function initialsCount(permCount: number): string {
  return String(permCount)
}

// ─── View ───────────────────────────────────────────────────────────

export default function RolesView() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<CustomRole | null>(null)
  const [form, setForm] = useState<RoleForm>({ name: '', permissions: [] })

  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: () => fetcher<{ roles: CustomRole[] }>('/api/roles'),
  })

  const roles = useMemo(
    () => [...(rolesQuery.data?.roles ?? [])].sort((a, b) => a.id - b.id),
    [rolesQuery.data],
  )

  const isCreate = editing === null
  const nameTrim = form.name.trim()
  const nameError =
    nameTrim === '' ? t('admin.roleNameRequired') : nameTrim.length < 2 || nameTrim.length > 40 ? t('admin.roleNameLen') : undefined

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = { name: nameTrim, permissions: form.permissions }
      return editing === null
        ? apiFetch<{ role: CustomRole }>('/api/roles', { method: 'POST', body: payload })
        : apiFetch<{ role: CustomRole }>(`/api/roles/${editing.id}`, {
            method: 'PUT',
            body: payload,
          })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['roles'] })
      toast.success(editing === null ? t('admin.roleCreated') : t('admin.roleUpdated'))
      setFormOpen(false)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      apiFetch<{ role: CustomRole }>(`/api/roles/${id}`, { method: 'PUT', body: { active } }),
    onMutate: async ({ id, active }) => {
      await queryClient.cancelQueries({ queryKey: ['roles'] })
      const prev = queryClient.getQueryData<{ roles: CustomRole[] }>(['roles'])
      if (prev) {
        queryClient.setQueryData(['roles'], {
          roles: prev.roles.map((r) => (r.id === id ? { ...r, active } : r)),
        })
      }
      return { prev }
    },
    onSuccess: (_data, vars) => {
      toast.success(vars.active ? t('admin.roleActivated') : t('admin.roleDeactivated'))
    },
    onError: (err: Error, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['roles'], ctx.prev)
      toast.error(err.message)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['roles'] })
    },
  })

  function openCreate() {
    setEditing(null)
    setForm({ name: '', permissions: [] })
    setFormOpen(true)
  }

  function openEdit(role: CustomRole) {
    setEditing(role)
    setForm({ name: role.name, permissions: [...role.permissions] })
    setFormOpen(true)
  }

  function togglePermission(perm: string) {
    setForm((prev) => ({
      ...prev,
      permissions: prev.permissions.includes(perm)
        ? prev.permissions.filter((p) => p !== perm)
        : [...prev.permissions, perm],
    }))
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      {/* Header — Odoo control-panel style */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-1">
          <nav aria-label="Breadcrumb" className="text-xs text-muted-foreground">
            <span>{t('nav.home')}</span>
            <span className="mx-1.5" aria-hidden>
              /
            </span>
            <span className="font-medium text-primary">{t('nav.roles')}</span>
          </nav>
          <h1 className="text-2xl font-bold tracking-tight">{t('nav.roles')}</h1>
          <p className="text-sm text-muted-foreground">{t('admin.rolesSubtitle')}</p>
        </div>
        <Button className="h-11" onClick={openCreate}>
          <Plus /> {t('admin.newRole')}
        </Button>
      </div>

      {/* Role cards */}
      {rolesQuery.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Card key={i} className="space-y-4 p-5">
              <div className="flex items-center justify-between gap-3">
                <Skeleton className="h-6 w-32" />
                <Skeleton className="h-5 w-9" />
              </div>
              <Skeleton className="h-4 w-24" />
              <div className="flex flex-wrap gap-1.5">
                <Skeleton className="h-6 w-20 rounded-full" />
                <Skeleton className="h-6 w-16 rounded-full" />
                <Skeleton className="h-6 w-24 rounded-full" />
              </div>
            </Card>
          ))}
        </div>
      ) : rolesQuery.isError ? (
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
          <TriangleAlert className="size-10 text-destructive" aria-hidden />
          <div>
            <p className="font-medium">{t('admin.loadRolesFailed')}</p>
            <p className="text-muted-foreground text-sm">
              {rolesQuery.error?.message ?? t('common.error')}
            </p>
          </div>
          <Button
            variant="outline"
            className="h-11"
            onClick={() => void rolesQuery.refetch()}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : roles.length === 0 ? (
        <Card className="flex flex-col items-center justify-center gap-3 border-dashed p-12 py-16 text-center">
          <ShieldCheck className="size-12 text-muted-foreground/40" aria-hidden />
          <div className="space-y-1">
            <p className="font-semibold">{t('admin.noRoles')}</p>
            <p className="text-sm text-muted-foreground">{t('admin.noRolesHint')}</p>
          </div>
          <Button className="h-11" onClick={openCreate}>
            <Plus /> {t('admin.newRole')}
          </Button>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {roles.map((role) => (
            <Card
              key={role.id}
              className={cn('space-y-4 p-5', !role.active && 'opacity-60')}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="truncate text-base font-bold leading-tight">{role.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('admin.usersOnRole', { count: role.userCount ?? 0 })}
                    <span className="mx-1.5" aria-hidden>
                      ·
                    </span>
                    {initialsCount(role.permissions.length)} {t('admin.permissions')}
                  </p>
                </div>
                <Switch
                  checked={role.active}
                  disabled={toggleMutation.isPending && toggleMutation.variables?.id === role.id}
                  onCheckedChange={(checked) => toggleMutation.mutate({ id: role.id, active: checked })}
                  aria-label={`${t('common.active')}: ${role.name}`}
                  title={t('admin.roleDeactivateHint')}
                />
              </div>

              <div className="flex flex-wrap gap-1.5">
                {role.permissions.length === 0 ? (
                  <span className="text-xs text-muted-foreground">—</span>
                ) : (
                  role.permissions.map((perm) => (
                    <Badge key={perm} variant="outline" className="text-xs">
                      {t(`nav.${perm}`)}
                    </Badge>
                  ))
                )}
              </div>

              <div className="flex items-center justify-between gap-2">
                <Badge
                  variant="outline"
                  className={
                    role.active
                      ? 'border-emerald-600/30 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400'
                      : 'text-muted-foreground'
                  }
                >
                  {role.active ? t('common.active') : t('common.inactive')}
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9"
                  onClick={() => openEdit(role)}
                >
                  <Pencil className="size-3.5" /> {t('common.edit')}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Create / edit dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{isCreate ? t('admin.newRole') : `${t('admin.editRole')} — ${editing?.name ?? ''}`}</DialogTitle>
            <DialogDescription>
              {isCreate ? t('admin.noRolesHint') : t('admin.editPermissions')}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="role-name">{t('admin.roleName')} *</Label>
              <Input
                id="role-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t('admin.roleNamePlaceholder')}
                className="h-11"
                aria-invalid={nameError ? true : undefined}
              />
              {nameError ? <p className="text-destructive text-xs">{nameError}</p> : null}
            </div>

            <div className="grid gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <Label>{t('admin.permissions')}</Label>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {t('admin.permissionsSelected', {
                    count: form.permissions.length,
                    total: PERMISSIONS.length,
                  })}
                </span>
              </div>
              <p className="text-muted-foreground text-xs">{t('admin.permissionsHint')}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {PERMISSIONS.map((perm) => {
                  const Icon = PERMISSION_ICONS[perm] ?? ShieldCheck
                  const checked = form.permissions.includes(perm)
                  return (
                    <div
                      key={perm}
                      role="checkbox"
                      aria-checked={checked}
                      tabIndex={0}
                      onClick={() => togglePermission(perm)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          togglePermission(perm)
                        }
                      }}
                      className={cn(
                        'flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-start transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                        checked && 'border-primary bg-primary/5',
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        tabIndex={-1}
                        aria-hidden
                        className="pointer-events-none mt-0.5"
                      />
                      <Icon
                        className={cn(
                          'mt-0.5 size-4 shrink-0',
                          checked ? 'text-primary' : 'text-muted-foreground',
                        )}
                        aria-hidden
                      />
                      <span className="min-w-0 space-y-0.5">
                        <span className="block text-sm font-medium leading-tight">
                          {t(`nav.${perm}`)}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {t(`admin.permDesc.${perm}`)}
                        </span>
                      </span>
                    </div>
                  )
                })}
              </div>
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
              disabled={saveMutation.isPending || nameError !== undefined}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Plus />
              )}
              {isCreate ? t('admin.createRole') : t('admin.saveChanges')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
