'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, UtensilsCrossed } from 'lucide-react'

import { Toaster } from '@/components/ui/sonner'
import { fetcher, apiFetch, clearSessionToken } from '@/lib/api'
import { RESTAURANT_NAME } from '@/lib/constants'
import { LanguageProvider, useI18n } from '@/lib/i18n'
import { clearNav, currentNav, onNav, pushNav, replaceNav } from '@/lib/nav'
import type { SessionUser } from '@/lib/types'
import { useAppSettings } from '@/lib/use-settings'

import LoginView from '@/components/auth/login-view'
import AppNavbar from '@/components/app-navbar'
import { IdleLogoutWatcher } from '@/components/idle-logout-watcher'
import PosView from '@/components/pos/pos-view'
import KitchenView from '@/components/kitchen/kitchen-view'
import DashboardView from '@/components/admin/dashboard-view'
import ProductsView from '@/components/admin/products-view'
import CategoriesView from '@/components/admin/categories-view'
import FloorPlansView from '@/components/admin/floorplans-view'
import ReservationsView from '@/components/admin/reservations-view'
import InventoryView from '@/components/admin/inventory-view'
import RecipesView from '@/components/admin/recipes-view'
import ReportsView from '@/components/admin/reports-view'
import ModifiersView from '@/components/admin/modifiers-view'
import CashDrawerView from '@/components/admin/cash-drawer-view'
import VisionView from '@/components/vision/vision-view'
import UsersView from '@/components/admin/users-view'
import RolesView from '@/components/admin/roles-view'
import AttendanceView from '@/components/admin/attendance-view'
import ActivityView from '@/components/admin/activity-view'
import SettingsView from '@/components/admin/settings-view'

type View =
  | 'pos'
  | 'kitchen'
  | 'dashboard'
  | 'products'
  | 'modifiers'
  | 'categories'
  | 'floorplans'
  | 'reservations'
  | 'inventory'
  | 'recipes'
  | 'reports'
  | 'cashdrawer'
  | 'vision'
  | 'users'
  | 'roles'
  | 'attendance'
  | 'activity'
  | 'settings'

/** which module permission each view requires */
const VIEW_PERMISSION: Record<View, string> = {
  pos: 'pos',
  kitchen: 'kitchen',
  dashboard: 'dashboard',
  products: 'products',
  modifiers: 'products',
  categories: 'categories',
  floorplans: 'floorplans',
  reservations: 'reservations',
  inventory: 'inventory',
  recipes: 'recipes',
  reports: 'reports',
  cashdrawer: 'cashdrawer',
  vision: 'vision',
  users: 'users',
  roles: 'roles',
  attendance: 'attendance',
  activity: 'audit',
  settings: 'settings',
}

const ADMIN_VIEWS: View[] = [
  'dashboard',
  'products',
  'modifiers',
  'categories',
  'floorplans',
  'reservations',
  'inventory',
  'recipes',
  'reports',
  'cashdrawer',
  'vision',
  'users',
  'roles',
  'attendance',
  'activity',
  'settings',
]

/** priority order used to pick the default view from the user's permissions */
const VIEW_PRIORITY: View[] = [
  'pos',
  'kitchen',
  'dashboard',
  'reports',
  'cashdrawer',
  'vision',
  'inventory',
  'attendance',
  'activity',
  'products',
  'modifiers',
  'categories',
  'floorplans',
  'reservations',
  'recipes',
  'users',
  'roles',
  'settings',
]

function defaultView(user: SessionUser): View {
  if (user.role === 'admin') return 'dashboard'
  const perms = user.permissions ?? []
  const first = VIEW_PRIORITY.find((v) => perms.includes(VIEW_PERMISSION[v]))
  return first ?? 'pos'
}

function isViewAllowed(user: SessionUser, view: View): boolean {
  if (user.role === 'admin') return true
  const perms = user.permissions ?? []
  return perms.includes(VIEW_PERMISSION[view])
}

/** All known top-level view names (hash segments). */
const ALL_VIEWS = new Set<string>(Object.keys(VIEW_PERMISSION))

/** The view for the current hash when it is valid + allowed for this user. */
function viewFromHash(user: SessionUser): View | null {
  const nav = currentNav()
  if (!nav || !ALL_VIEWS.has(nav.view)) return null
  return isViewAllowed(user, nav.view as View) ? (nav.view as View) : null
}

/** Full-screen splash while the session is being checked. */
function SplashScreen() {
  const { t } = useI18n()
  const { restaurantName } = useAppSettings()
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background">
      <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg">
        <UtensilsCrossed className="h-8 w-8" aria-hidden />
      </div>
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        <span className="text-sm font-medium">
          {t('common.loading')} {restaurantName}…
        </span>
      </div>
    </div>
  )
}

function AdminFooter() {
  const { t } = useI18n()
  const { restaurantName } = useAppSettings()
  return (
    <footer className="mt-auto border-t bg-card/60 px-4 py-3 text-center text-xs text-muted-foreground">
      {restaurantName} · {t('auth.subtitle')} — {t('nav.pos')} · {t('nav.kitchen')} ·{' '}
      {t('nav.inventory')} · {t('nav.reports')}
    </footer>
  )
}

function AppShell({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  // Round 7: the top-level view lives in the location hash (#/pos, #/kitchen,
  // #/reports… — the POS appends sub-hashes like #/pos/order/12, owned by
  // PosView). A deep-linked/refreshed hash is honored when the user is
  // allowed to see it, otherwise we fall back to their default view.
  const [view, setViewState] = useState<View>(() => viewFromHash(user) ?? defaultView(user))

  // First-load URL normalization ONLY (the view state itself was already
  // resolved in the lazy initializer — this effect never calls setState
  // directly): rewrite a bare/invalid hash, or a hash this user may not open,
  // to the current view's hash. Then subscribe to browser back/forward +
  // hand-edited hashes so the Back button moves between views in-app.
  useEffect(() => {
    const nav = currentNav()
    const hashed = nav && ALL_VIEWS.has(nav.view) ? (nav.view as View) : null
    if (hashed == null || !isViewAllowed(user, hashed)) replaceNav(view)
    return onNav((incoming) => {
      if (!incoming) return
      const next = ALL_VIEWS.has(incoming.view) ? (incoming.view as View) : null
      if (next && isViewAllowed(user, next)) {
        // Idempotent — popstate + hashchange may both fire for one press.
        setViewState((prev) => (prev === next ? prev : next))
      } else {
        // Unknown or disallowed hash (waiter hand-typing #/users): rewrite it
        // to the default view instead of leaving the app dead-ended.
        const fallback = defaultView(user)
        replaceNav(fallback)
        setViewState((prev) => (prev === fallback ? prev : fallback))
      }
    })
  }, [user, view])

  const setView = useCallback((next: string | View) => {
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0 })
      // Push a history entry only when the top-level view actually changes —
      // clicking "POS" while already on #/pos/order/12 must not flatten the
      // POS sub-hash (PosView re-asserts its deep hash when re-activated).
      const top = currentNav()?.view
      if (top !== next) pushNav(String(next))
    }
    setViewState(next as View)
  }, [])

  const allowed = isViewAllowed(user, view) ? view : defaultView(user)
  const isAdminScreen = ADMIN_VIEWS.includes(allowed)
  const posAllowed = isViewAllowed(user, 'pos')

  const content = useMemo(() => {
    switch (allowed) {
      case 'kitchen':
        return <KitchenView />
      case 'dashboard':
        return <DashboardView onNavigate={setView} />
      case 'products':
        return <ProductsView />
      case 'modifiers':
        return <ModifiersView />
      case 'categories':
        return <CategoriesView />
      case 'floorplans':
        return <FloorPlansView />
      case 'reservations':
        return <ReservationsView />
      case 'inventory':
        return <InventoryView />
      case 'recipes':
        return <RecipesView />
      case 'reports':
        return <ReportsView />
      case 'cashdrawer':
        return <CashDrawerView />
      case 'vision':
        return <VisionView />
      case 'users':
        return <UsersView />
      case 'roles':
        return <RolesView />
      case 'attendance':
        return <AttendanceView />
      case 'activity':
        return <ActivityView />
      case 'settings':
        return <SettingsView />
      default:
        return null
    }
  }, [allowed, setView])

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <AppNavbar user={user} view={allowed} onNavigate={setView} onLogout={onLogout} />
      <main className="flex-1 flex flex-col">
        {/* Round 7: the POS stays mounted (hidden) while other views are
            open, so an in-progress order screen and unsent draft survive view
            switches — and the browser Back button can return to them. */}
        {posAllowed && (
          <div className="flex min-h-0 flex-1 flex-col" hidden={allowed !== 'pos'}>
            <PosView active={allowed === 'pos'} />
          </div>
        )}
        {allowed !== 'pos' && content}
        {isAdminScreen && <AdminFooter />}
      </main>
      {/* Idle session timeout (shared terminals) — 15 min warn + 60s countdown */}
      <IdleLogoutWatcher onLogout={onLogout} />
    </div>
  )
}

export default function Home() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
            staleTime: 5_000,
          },
        },
      }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <Toaster position="top-center" closeButton richColors />
        <RmsApp />
      </LanguageProvider>
    </QueryClientProvider>
  )
}

function RmsApp() {
  const queryClient = useQueryClient()

  const {
    data: session,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['session'],
    queryFn: () => fetcher<{ user: SessionUser }>('/api/auth/me'),
    retry: false,
    staleTime: 60_000,
  })

  const handleLogin = useCallback(async () => {
    await refetch()
  }, [refetch])

  const handleLogout = useCallback(async () => {
    clearSessionToken()
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' })
    } catch {
      // cookie is cleared server-side; ignore network hiccups
    }
    // Drop the app hash so the next sign-in starts from a clean default view
    // (Round 7 hash-based navigation).
    clearNav()
    queryClient.removeQueries()
    await refetch()
  }, [queryClient, refetch])

  if (isLoading) return <SplashScreen />

  const user = session?.user
  if (isError || !user) {
    return <LoginView onLogin={handleLogin} />
  }

  return <AppShell user={user} onLogout={handleLogout} />
}
