'use client'

// ─── R25: Launcher Home — the Team Wall, inside the app ──────────────
// The bridge between the zero-reading Team Wall (sign-in kiosk) and the
// working screens. After "MY SCREEN" the employee lands HERE: the same
// design language they just used to clock in —
//   · big colorful tiles (recognition, not reading) with giant icons
//   · warm deterministic colors per module (no blue/indigo, per house style)
//   · ONE tap = one destination; tap feedback tick + haptic (shared lib)
//   · LIVE badges: open orders, items to prepare, low stock, on-shift —
//     numbers tell the story even when words can't
//   · bilingual EN + Egyptian Arabic, RTL-correct
// A waiter sees one giant "Take orders" tile (and kitchen, if allowed).
// An admin sees everything, grouped Work / Manage / Team & System.

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart3,
  BookOpen,
  Boxes,
  CalendarCheck,
  CalendarDays,
  Cctv,
  ChefHat,
  CircleDollarSign,
  ClipboardCheck,
  Hand,
  LayoutDashboard,
  Map,
  Package,
  Plug,
  ScrollText,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Tags,
  Truck,
  UserRound,
  Users,
  Utensils,
  Wallet,
  Zap,
  type LucideIcon,
} from 'lucide-react'

import { fetcher } from '@/lib/api'
import { sndTap, haptic } from '@/lib/feedback'
import { useI18n } from '@/lib/i18n'
import { useAppSettings } from '@/lib/use-settings'
import { cn } from '@/lib/utils'
import type { Order, SessionUser } from '@/lib/types'

// ── warm palette (deterministic per module; literals so Tailwind sees them)
type TileDef = {
  view: string
  icon: LucideIcon
  gradient: string
  subKey?: string
  badge?: 'openOrders' | 'pendingItems' | 'lowStock' | 'onShift'
}

const OPERATIONS: TileDef[] = [
  { view: 'pos', icon: Utensils, gradient: 'from-amber-500 to-orange-600', subKey: 'home.posSub', badge: 'openOrders' },
  { view: 'kitchen', icon: ChefHat, gradient: 'from-rose-500 to-red-600', subKey: 'home.kitchenSub', badge: 'pendingItems' },
  { view: 'reservations', icon: CalendarCheck, gradient: 'from-orange-500 to-amber-600', subKey: 'home.reservationsSub' },
  { view: 'cashdrawer', icon: CircleDollarSign, gradient: 'from-lime-500 to-emerald-600', subKey: 'home.cashdrawerSub' },
  { view: 'vision', icon: Cctv, gradient: 'from-fuchsia-500 to-pink-600', subKey: 'home.visionSub' },
]

const MANAGE: TileDef[] = [
  { view: 'dashboard', icon: LayoutDashboard, gradient: 'from-stone-600 to-zinc-800', subKey: 'home.dashboardSub' },
  { view: 'reports', icon: BarChart3, gradient: 'from-teal-500 to-emerald-700', subKey: 'home.reportsSub' },
  { view: 'inventory', icon: Boxes, gradient: 'from-emerald-500 to-green-700', subKey: 'home.inventorySub', badge: 'lowStock' },
  { view: 'purchases', icon: Truck, gradient: 'from-green-600 to-teal-700' },
  { view: 'stockcounts', icon: ClipboardCheck, gradient: 'from-lime-600 to-green-700' },
  { view: 'products', icon: Package, gradient: 'from-orange-600 to-red-700' },
  { view: 'modifiers', icon: SlidersHorizontal, gradient: 'from-amber-600 to-orange-700' },
  { view: 'categories', icon: Tags, gradient: 'from-yellow-600 to-amber-700' },
  { view: 'recipes', icon: BookOpen, gradient: 'from-rose-600 to-pink-700' },
  { view: 'promotions', icon: Zap, gradient: 'from-fuchsia-600 to-rose-700' },
  { view: 'customers', icon: UserRound, gradient: 'from-orange-700 to-amber-800' },
  { view: 'floorplans', icon: Map, gradient: 'from-teal-600 to-emerald-800' },
]

const TEAM_SYSTEM: TileDef[] = [
  { view: 'users', icon: Users, gradient: 'from-stone-500 to-stone-700' },
  { view: 'roles', icon: ShieldCheck, gradient: 'from-rose-700 to-red-800' },
  { view: 'attendance', icon: CalendarDays, gradient: 'from-emerald-600 to-teal-700', badge: 'onShift' },
  { view: 'payroll', icon: Wallet, gradient: 'from-amber-700 to-orange-800' },
  { view: 'activity', icon: ScrollText, gradient: 'from-zinc-600 to-zinc-800' },
  { view: 'integrations', icon: Plug, gradient: 'from-teal-700 to-emerald-800' },
  { view: 'settings', icon: Settings, gradient: 'from-stone-600 to-stone-800' },
]

/** module permission per view (mirrors page.tsx VIEW_PERMISSION) */
const VIEW_PERMISSION: Record<string, string> = {
  pos: 'pos',
  kitchen: 'kitchen',
  dashboard: 'dashboard',
  products: 'products',
  modifiers: 'products',
  categories: 'categories',
  floorplans: 'floorplans',
  reservations: 'reservations',
  customers: 'customers',
  inventory: 'inventory',
  purchases: 'purchases',
  stockcounts: 'inventory',
  recipes: 'recipes',
  promotions: 'promotions',
  reports: 'reports',
  cashdrawer: 'cashdrawer',
  vision: 'vision',
  users: 'users',
  roles: 'roles',
  attendance: 'attendance',
  payroll: 'payroll',
  activity: 'audit',
  integrations: 'settings',
  settings: 'settings',
}

// ── same warm avatar palette as the Team Wall (shared identity) ─────
const AVATAR_PALETTE = [
  'bg-amber-600',
  'bg-orange-600',
  'bg-rose-600',
  'bg-emerald-600',
  'bg-teal-600',
  'bg-fuchsia-600',
  'bg-red-600',
  'bg-lime-700',
]

function avatarColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/)
  const first = parts[0]?.charAt(0) ?? '?'
  const second = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : ''
  return (first + second).toUpperCase()
}

type WallRoster = {
  team: { id: number; onShift: boolean; checkedInAt: string | null }[]
  onShiftCount: number
}

export default function LauncherView({
  user,
  onNavigate,
}: {
  user: SessionUser
  onNavigate: (view: string) => void
}) {
  const { t, isRTL } = useI18n()
  const { restaurantName } = useAppSettings()

  const isAdmin = user.role === 'admin'
  const perms = user.permissions ?? []
  const can = useMemo(
    () => (view: string) => isAdmin || perms.includes(VIEW_PERMISSION[view] ?? ''),
    [isAdmin, perms],
  )

  // ── live clock (20s tick — minute precision is enough here) ──
  const [clock, setClock] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 20_000)
    return () => clearInterval(timer)
  }, [])
  const hour = clock.getHours()
  const greetingKey =
    hour < 12 ? 'home.greetingMorning' : hour < 17 ? 'home.greetingAfternoon' : 'home.greetingEvening'
  const clockText = clock.toLocaleTimeString(isRTL ? 'ar-EG-u-nu-latn' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

  // ── live badges (shared query keys → TanStack dedupes with the views) ──
  const wantsOrders = can('pos') || can('kitchen')
  const { data: openData } = useQuery({
    queryKey: ['orders', 'open'],
    queryFn: () => fetcher<{ orders: Order[] }>('/api/orders?status=open'),
    refetchInterval: 15_000,
    staleTime: 10_000,
    enabled: wantsOrders,
  })
  const openOrdersCount = openData?.orders?.length ?? 0
  const pendingItemsCount = useMemo(
    () =>
      (openData?.orders ?? []).reduce(
        (sum, o) => sum + o.items.filter((item) => item.status !== 'served').length,
        0,
      ),
    [openData],
  )

  const { data: lowStockData } = useQuery({
    queryKey: ['inventory', 'low-stock'],
    queryFn: () => fetcher<{ items: unknown[] }>('/api/inventory/low-stock'),
    refetchInterval: 60_000,
    staleTime: 30_000,
    enabled: can('inventory'),
  })
  const lowStockCount = lowStockData?.items?.length ?? 0

  const { data: roster } = useQuery({
    queryKey: ['team-wall'],
    queryFn: () => fetcher<WallRoster>('/api/auth/team-wall'),
    refetchInterval: 20_000,
    staleTime: 10_000,
  })
  const me = roster?.team.find((m) => m.id === user.id)
  const onShiftCount = roster?.onShiftCount ?? 0

  const badges: Record<string, number> = {
    openOrders: openOrdersCount,
    pendingItems: pendingItemsCount,
    lowStock: lowStockCount,
    onShift: onShiftCount,
  }

  const groups = useMemo(() => {
    const build = (defs: TileDef[]) => defs.filter((d) => isAdmin || perms.includes(VIEW_PERMISSION[d.view] ?? ''))
    return [
      { key: 'home.groupOperations', defs: build(OPERATIONS) },
      { key: 'home.groupManage', defs: build(MANAGE) },
      { key: 'home.groupTeam', defs: build(TEAM_SYSTEM) },
    ].filter((g) => g.defs.length > 0)
  }, [isAdmin, perms])

  const firstName = user.name.trim().split(/\s+/)[0] ?? user.name
  const roleLabel = user.role === 'custom' ? (user.roleName ?? t('role.custom')) : t(`role.${user.role}`)

  return (
    <section className="flex-1 bg-background">
      {/* ── Hero band: who is this + live shift status (the wall identity) ── */}
      <div className="border-b bg-card/60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-6 sm:px-6">
          <div
            className={cn(
              'grid size-16 shrink-0 place-items-center rounded-2xl text-xl font-bold text-white shadow-lg sm:size-20 sm:text-2xl',
              avatarColor(user.name),
            )}
            aria-hidden
          >
            {initialsOf(user.name)}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-bold leading-tight sm:text-3xl">
              {t(greetingKey)}, {firstName} 👋
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <span>{restaurantName}</span>
              <span aria-hidden>·</span>
              <span>{roleLabel}</span>
              {me?.onShift && (
                <>
                  <span aria-hidden>·</span>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-0.5 font-medium text-emerald-700">
                    <span className="relative flex size-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                    </span>
                    {t('home.onShift')}
                  </span>
                </>
              )}
            </p>
          </div>
          <div className="ms-auto text-end">
            <div className="text-3xl font-bold tabular-nums leading-none sm:text-4xl">{clockText}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t('home.tapToStart')}</p>
          </div>
        </div>
      </div>

      {/* ── Tile groups ── */}
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        {groups.map((group) => (
          <section key={group.key} className="mb-8 last:mb-2" aria-label={t(group.key)}>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              {t(group.key)}
            </h2>
            <div
              className={cn(
                'grid gap-4',
                group.defs.length <= 2
                  ? 'grid-cols-1 sm:grid-cols-2'
                  : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5',
              )}
            >
              {group.defs.map((def) => (
                <LauncherTile
                  key={def.view}
                  def={def}
                  label={t(`nav.${def.view}`)}
                  badgeCount={def.badge ? badges[def.badge] : 0}
                  onOpen={() => {
                    sndTap()
                    haptic(8)
                    onNavigate(def.view)
                  }}
                />
              ))}
            </div>
          </section>
        ))}

        <p className="mt-2 flex items-center justify-center gap-2 pb-4 text-sm text-muted-foreground">
          <Hand className="size-4" aria-hidden />
          {t('home.tapToStart')}
        </p>
      </div>
    </section>
  )
}

function LauncherTile({
  def,
  label,
  badgeCount,
  onOpen,
}: {
  def: TileDef
  label: string
  badgeCount: number
  onOpen: () => void
}) {
  const { t } = useI18n()
  const Icon = def.icon
  const sub = def.subKey ? t(def.subKey) : null
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      className={cn(
        'group relative flex min-h-28 flex-col items-start justify-between gap-3 rounded-2xl bg-gradient-to-br p-4 text-start text-white shadow-md transition',
        'hover:shadow-lg hover:brightness-110 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/60 active:scale-95',
        def.gradient,
      )}
    >
      {/* live badge pill — numbers tell the story */}
      {badgeCount > 0 && (
        <span className="absolute end-3 top-3 inline-flex min-w-8 items-center justify-center rounded-full bg-white/95 px-2 py-0.5 text-sm font-bold tabular-nums text-stone-800 shadow">
          {badgeCount}
          <span className="absolute inset-0 -z-10 animate-ping rounded-full bg-white/40" aria-hidden />
        </span>
      )}
      <span className="grid size-12 place-items-center rounded-xl bg-white/20 shadow-inner sm:size-14">
        <Icon className="size-6 sm:size-7" strokeWidth={2.2} aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-base font-bold leading-tight sm:text-lg">{label}</span>
        {sub && <span className="mt-0.5 block truncate text-sm text-white/85">{sub}</span>}
      </span>
    </button>
  )
}
