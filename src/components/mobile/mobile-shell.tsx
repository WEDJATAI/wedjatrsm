'use client'

// ─── R15: Mobile shell — role-adaptive phone chrome ─────────────────
// Owner: 15-c. Rendered by page.tsx's AppShell instead of the desktop
// navbar/main/footer tree when useIsMobile() is true (viewport < 768px).
// ONE platform, ONE login: the phone gets a top bar + bottom tab bar
// whose tabs adapt to the signed-in role —
//   · default view 'pos'    → Tables · My Orders · More  (Waiter Portal)
//   · default view 'kitchen'→ Tickets · More
//   · admin (dashboard)     → Home · More
//   · anything else         → <default view> · More
// "More" opens a bottom sheet listing every view the user is allowed to
// open (same permissions as the desktop navbar), grouped Operations vs
// Admin. The Waiter Portal stays mounted (hidden) while other views are
// open, so unsent drafts survive — the mobile twin of the desktop's
// always-mounted PosView.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import {
  BarChart3,
  BookOpen,
  Boxes,
  CalendarCheck,
  CalendarDays,
  Cctv,
  ChefHat,
  Check,
  CircleDollarSign,
  ClipboardCheck,
  ClipboardList,
  House,
  Languages,
  LayoutDashboard,
  LogOut,
  Map,
  Package,
  Plug,
  ScrollText,
  Settings,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Tags,
  Truck,
  UserRound,
  Users,
  Utensils,
  UtensilsCrossed,
  Wallet,
  Zap,
  type LucideIcon,
} from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'

import { fetcher } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { useAppSettings } from '@/lib/use-settings'
import { cn } from '@/lib/utils'
import type { Order, SessionUser } from '@/lib/types'

import WaiterPortal, { type WaiterPortalTab } from '@/components/mobile/waiter-portal'

/** view name → nav icon (mirrors app-navbar's MAIN_ITEMS + ADMIN_MENU). */
const VIEW_ICONS: Record<string, LucideIcon> = {
  home: House,
  pos: Utensils,
  kitchen: ChefHat,
  dashboard: LayoutDashboard,
  products: Package,
  modifiers: SlidersHorizontal,
  categories: Tags,
  floorplans: Map,
  reservations: CalendarCheck,
  customers: UserRound,
  inventory: Boxes,
  purchases: Truck,
  stockcounts: ClipboardCheck,
  recipes: BookOpen,
  promotions: Zap,
  reports: BarChart3,
  cashdrawer: CircleDollarSign,
  payroll: Wallet,
  vision: Cctv,
  users: Users,
  roles: ShieldCheck,
  attendance: CalendarDays,
  activity: ScrollText,
  integrations: Plug,
  settings: Settings,
}

/** Operations group of the More sheet (same split as the desktop navbar). */
const OPERATIONS_VIEWS = ['pos', 'kitchen']
/** Admin group (order mirrors app-navbar's ADMIN_MENU). */
const ADMIN_VIEWS = [
  'dashboard',
  'products',
  'modifiers',
  'categories',
  'floorplans',
  'reservations',
  'customers',
  'inventory',
  'purchases',
  'stockcounts',
  'recipes',
  'promotions',
  'reports',
  'cashdrawer',
  'payroll',
  'vision',
  'users',
  'roles',
  'attendance',
  'activity',
  'integrations',
  'settings',
]

/** Soft role tints for the light mobile top bar. */
const ROLE_BADGE_CLASS: Record<string, string> = {
  admin: 'border-primary/40 bg-primary/10 text-primary',
  waiter: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  kitchen: 'border-rose-300 bg-rose-50 text-rose-700',
  custom: 'border-amber-300 bg-amber-50 text-amber-700',
}

type MobileTab =
  | { kind: 'waiter-tab'; key: WaiterPortalTab; label: string; icon: LucideIcon; badge?: number }
  | { kind: 'view'; view: string; label: string; icon: LucideIcon }
  | { kind: 'more'; label: string; icon: LucideIcon }

export default function MobileShell({
  user,
  view,
  setView,
  onLogout,
  allowedViews,
  defaultViewName,
  content,
  posAllowed,
}: {
  user: SessionUser
  /** the resolved active view ('pos' shows the Waiter Portal) */
  view: string
  /** same setView the desktop AppShell uses (hash-based nav + permissions) */
  setView: (view: string) => void
  onLogout: () => void
  /** every view this user is allowed to open (More sheet entries) */
  allowedViews: string[]
  /** defaultView(user) — decides the role-adaptive tab set */
  defaultViewName: string
  /** pre-rendered non-pos view content (the AppShell `content` memo) */
  content: ReactNode
  /** may this user open the POS (mobile Waiter Portal)? */
  posAllowed: boolean
}) {
  const { t, lang, toggleLang } = useI18n()
  const { restaurantName } = useAppSettings()

  const [waiterTab, setWaiterTab] = useState<WaiterPortalTab>('tables')
  const [moreOpen, setMoreOpen] = useState(false)
  const [logoutOpen, setLogoutOpen] = useState(false)

  // Online/offline dot (live listeners, mirrors OfflineBanner's signal).
  const [online, setOnline] = useState(true)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  // My-open-orders count for the tab badge (waiters). Shared query key
  // with the portal/floor — TanStack dedupes the polls.
  const waiterLike = posAllowed && defaultViewName === 'pos'
  const { data: openOrdersData } = useQuery({
    queryKey: ['orders', 'open'],
    queryFn: () => fetcher<{ orders: Order[] }>('/api/orders?status=open'),
    refetchInterval: 30000,
    enabled: waiterLike,
  })
  const myOpenCount = useMemo(
    () => (openOrdersData?.orders ?? []).filter((o) => o.status === 'open' && o.user?.id === user.id).length,
    [openOrdersData, user.id],
  )

  // Role-adaptive tab set — R25: every set leads with the Launcher Home
  // (the in-app Team Wall: tap a big tile to start working).
  const tabs = useMemo<MobileTab[]>(() => {
    const home: MobileTab = { kind: 'view', view: 'home', label: t('nav.home'), icon: House }
    const more: MobileTab = { kind: 'more', label: t('m.more'), icon: Settings2 }
    if (waiterLike) {
      return [
        home,
        { kind: 'waiter-tab', key: 'tables', label: t('m.tables'), icon: UtensilsCrossed },
        { kind: 'waiter-tab', key: 'orders', label: t('m.myOrders'), icon: ClipboardList, badge: myOpenCount },
        more,
      ]
    }
    if (defaultViewName === 'kitchen') {
      return [home, { kind: 'view', view: 'kitchen', label: t('m.tickets'), icon: ChefHat }, more]
    }
    if (defaultViewName === 'dashboard') {
      return [
        home,
        { kind: 'view', view: 'dashboard', label: t('nav.dashboard'), icon: LayoutDashboard },
        more,
      ]
    }
    const icon = VIEW_ICONS[defaultViewName] ?? LayoutDashboard
    return [
      home,
      { kind: 'view', view: defaultViewName, label: t(`nav.${defaultViewName}`), icon },
      more,
    ]
  }, [waiterLike, defaultViewName, myOpenCount, t])

  // More sheet groups (allowed views only, navbar grouping).
  const allowed = useMemo(() => new Set(allowedViews), [allowedViews])
  const opsEntries = useMemo(() => OPERATIONS_VIEWS.filter((v) => allowed.has(v)), [allowed])
  const adminEntries = useMemo(() => ADMIN_VIEWS.filter((v) => allowed.has(v)), [allowed])

  // Reset the scrollable main whenever the top-level view changes (the
  // desktop tree scrolls the window; here the main element scrolls).
  const mainRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
  }, [view, waiterTab])

  const roleLabel = user.role === 'custom' ? (user.roleName ?? t('role.custom')) : t(`role.${user.role}`)
  const firstName = user.name.trim().split(/\s+/)[0] ?? user.name

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-background">
      {/* ── Top bar (brand · status · language · user · logout) — r48: the
          same deep plum-charcoal glass shell as the desktop navbar ── */}
      <header className="glass-shell z-40 shrink-0 border-b border-shell-border text-shell-foreground shadow-sm">
        <div className="flex h-14 items-center gap-2 px-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-linear-to-br from-[oklch(0.48_0.1_338)] to-[oklch(0.32_0.09_338)] text-white shadow-[0_2px_12px_oklch(0.42_0.085_338/0.45)]">
            <UtensilsCrossed className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold leading-tight">{restaurantName}</p>
            <p className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-shell-muted">
              <span
                className={cn('inline-block size-1.5 rounded-full', online ? 'bg-emerald-400' : 'bg-white/40')}
                aria-hidden
              />
              <span className="sr-only">{online ? t('m.online') : t('m.offline')}</span>
              <span className="truncate normal-case">
                {firstName} · {roleLabel}
              </span>
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleLang}
            aria-label={lang === 'en' ? t('lang.arabic') : t('lang.english')}
            title={lang === 'en' ? t('lang.arabic') : t('lang.english')}
            className="size-11 shrink-0 text-shell-muted transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-white/60"
          >
            <Languages className="h-5 w-5" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setLogoutOpen(true)}
            aria-label={t('nav.logout')}
            title={t('nav.logout')}
            className="size-11 shrink-0 text-shell-muted transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-white/60"
          >
            <LogOut className="h-5 w-5" aria-hidden />
          </Button>
        </div>
      </header>

      {/* ── Content: Waiter Portal (kept mounted) or the active view ── */}
      <main
        id="rms-main"
        tabIndex={-1}
        ref={mainRef}
        className="rms-scroll flex min-h-0 flex-1 flex-col overflow-y-auto outline-none"
      >
        {posAllowed && (
          <div className="flex min-h-0 flex-1 flex-col" hidden={view !== 'pos'}>
            <WaiterPortal user={user} active={view === 'pos'} tab={waiterTab} onSwitchTab={setWaiterTab} />
          </div>
        )}
        {view !== 'pos' && content}
      </main>

      {/* ── Bottom tab bar (role-adaptive) — r48: dark glass shell with
          iOS safe-area padding (.safe-bottom) for notched phones; the
          active tab indicator slides between tabs via a shared layoutId ── */}
      <nav
        aria-label={t('nav.home')}
        className="glass-shell safe-bottom z-40 shrink-0 border-t border-shell-border text-shell-foreground"
      >
        <div className="flex items-stretch justify-around" role="tablist">
          {tabs.map((tab) => {
            const Icon = tab.icon
            const active =
              tab.kind === 'waiter-tab'
                ? view === 'pos' && waiterTab === tab.key
                : tab.kind === 'view'
                  ? view === tab.view
                  : false
            return (
              <button
                key={tab.kind === 'waiter-tab' ? `wt-${tab.key}` : tab.kind === 'view' ? `v-${tab.view}` : 'more'}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={tab.label}
                aria-current={tab.kind !== 'more' && active ? 'page' : undefined}
                onClick={() => {
                  if (tab.kind === 'waiter-tab') setWaiterTab(tab.key)
                  else if (tab.kind === 'view') setView(tab.view)
                  else setMoreOpen(true)
                }}
                className={cn(
                  'relative flex min-h-[60px] min-w-16 flex-1 flex-col items-center justify-center gap-0.5 px-2 py-1.5 text-[11px] font-medium transition-colors',
                  active ? 'text-white' : 'text-shell-muted hover:text-shell-foreground',
                )}
              >
                {/* r48: plum gradient indicator slides between tabs */}
                {active && (
                  <motion.span
                    layoutId="mobile-tab-indicator"
                    className="absolute inset-x-4 top-0 h-1 rounded-b-full bg-linear-to-r from-[oklch(0.62_0.1_338)] to-[oklch(0.42_0.085_338)] shadow-[0_2px_10px_oklch(0.55_0.1_338/0.7)]"
                    transition={{ type: 'spring', stiffness: 480, damping: 38 }}
                    aria-hidden
                  />
                )}
                {/* fixed-size icon chip — soft emphasis when active, no layout shift */}
                <span
                  className={cn(
                    'relative grid size-8 place-items-center rounded-full transition-colors',
                    active && 'bg-white/10',
                  )}
                >
                  <Icon className="size-5" aria-hidden />
                  {tab.kind === 'waiter-tab' && (tab.badge ?? 0) > 0 && (
                    <span className="absolute -end-1 -top-1 flex min-w-4 items-center justify-center rounded-full bg-linear-to-b from-[oklch(0.75_0.15_70)] to-[oklch(0.67_0.17_55)] px-1 text-[9px] font-bold tabular-nums text-zinc-950 shadow-sm">
                      {tab.badge}
                    </span>
                  )}
                </span>
                <span className={cn('max-w-full truncate', active && 'font-semibold')}>{tab.label}</span>
              </button>
            )
          })}
        </div>
      </nav>

      {/* ── More sheet — every allowed view, grouped like the navbar ── */}
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent
          side="bottom"
          className="card-elevated-3 rms-scroll max-h-[82dvh] overflow-y-auto rounded-t-3xl px-0 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
        >
          <SheetHeader className="px-4 pb-1">
            {/* r48: grab handle — a bottom sheet affordance for thumb swipes */}
            <span
              className="mx-auto mb-1 block h-1.5 w-10 rounded-full bg-muted-foreground/25"
              aria-hidden
            />
            <SheetTitle className="flex flex-wrap items-center gap-2 text-base">
              {t('m.more')}
              <Badge
                variant="outline"
                className={cn(ROLE_BADGE_CLASS[user.role] ?? 'border-border bg-muted text-muted-foreground')}
              >
                {roleLabel}
              </Badge>
            </SheetTitle>
          </SheetHeader>

          {opsEntries.length > 0 && (
            <section className="px-2 pb-2">
              <h3 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t('m.menuOperations')}
              </h3>
              <MoreRow
                entries={opsEntries}
                currentView={view}
                onNavigate={(v) => {
                  setMoreOpen(false)
                  setView(v)
                }}
              />
            </section>
          )}

          {adminEntries.length > 0 && (
            <section className="px-2 pb-2">
              <h3 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t('m.menuAdmin')}
              </h3>
              <div className="grid grid-cols-2 gap-1.5">
                {adminEntries.map((v) => (
                  <MoreCell key={v} view={v} active={view === v} onNavigate={(x) => {
                    setMoreOpen(false)
                    setView(x)
                  }} />
                ))}
              </div>
            </section>
          )}
        </SheetContent>
      </Sheet>

      {/* ── Logout confirm ── */}
      <AlertDialog open={logoutOpen} onOpenChange={setLogoutOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('m.logoutTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('m.logoutDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault()
                setLogoutOpen(false)
                onLogout()
              }}
            >
              <LogOut className="size-4" /> {t('nav.logout')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** Full-width More-sheet row (Operations group). */
function MoreRow({
  entries,
  currentView,
  onNavigate,
}: {
  entries: string[]
  currentView: string
  onNavigate: (view: string) => void
}) {
  const { t } = useI18n()
  return (
    <ul className="space-y-1">
      {entries.map((v) => {
        const Icon = VIEW_ICONS[v] ?? LayoutDashboard
        const active = currentView === v
        return (
          <li key={v}>
            <button
              type="button"
              onClick={() => onNavigate(v)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 text-start text-sm font-medium transition active:scale-[0.98]',
                active ? 'bg-primary/10 text-primary' : 'text-stone-700 hover:bg-muted/60',
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{t(`nav.${v}`)}</span>
              {active && <Check className="size-4 shrink-0" aria-hidden />}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** Compact More-sheet cell (Admin group — 2-col grid). */
function MoreCell({
  view,
  active,
  onNavigate,
}: {
  view: string
  active: boolean
  onNavigate: (view: string) => void
}) {
  const { t } = useI18n()
  const Icon = VIEW_ICONS[view] ?? LayoutDashboard
  return (
    <button
      type="button"
      onClick={() => onNavigate(view)}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex min-h-[60px] w-full flex-col items-center justify-center gap-1 rounded-xl border px-2 py-2 text-center text-xs font-medium transition active:scale-[0.97] card-elevated',
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border bg-card text-stone-600 hover:border-primary/40',
      )}
    >
      <Icon className="size-5 shrink-0" aria-hidden />
      <span className="max-w-full truncate">{t(`nav.${view}`)}</span>
    </button>
  )
}
