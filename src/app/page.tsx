'use client'

import { useCallback, useMemo, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, UtensilsCrossed } from 'lucide-react'

import { Toaster } from '@/components/ui/sonner'
import { fetcher, apiFetch, clearSessionToken } from '@/lib/api'
import { RESTAURANT_NAME } from '@/lib/constants'
import { LanguageProvider, useI18n } from '@/lib/i18n'
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
import InventoryView from '@/components/admin/inventory-view'
import RecipesView from '@/components/admin/recipes-view'
import ReportsView from '@/components/admin/reports-view'
import UsersView from '@/components/admin/users-view'
import RolesView from '@/components/admin/roles-view'
import AttendanceView from '@/components/admin/attendance-view'
import SettingsView from '@/components/admin/settings-view'

type View =
  | 'pos'
  | 'kitchen'
  | 'dashboard'
  | 'products'
  | 'categories'
  | 'floorplans'
  | 'inventory'
  | 'recipes'
  | 'reports'
  | 'users'
  | 'roles'
  | 'attendance'
  | 'settings'

/** which module permission each view requires */
const VIEW_PERMISSION: Record<View, string> = {
  pos: 'pos',
  kitchen: 'kitchen',
  dashboard: 'dashboard',
  products: 'products',
  categories: 'categories',
  floorplans: 'floorplans',
  inventory: 'inventory',
  recipes: 'recipes',
  reports: 'reports',
  users: 'users',
  roles: 'roles',
  attendance: 'attendance',
  settings: 'settings',
}

const ADMIN_VIEWS: View[] = [
  'dashboard',
  'products',
  'categories',
  'floorplans',
  'inventory',
  'recipes',
  'reports',
  'users',
  'roles',
  'attendance',
  'settings',
]

/** priority order used to pick the default view from the user's permissions */
const VIEW_PRIORITY: View[] = [
  'pos',
  'kitchen',
  'dashboard',
  'reports',
  'inventory',
  'attendance',
  'products',
  'categories',
  'floorplans',
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
  const [view, setViewState] = useState<View>(defaultView(user))

  const setView = useCallback((next: string | View) => {
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 })
    setViewState(next as View)
  }, [])

  const allowed = isViewAllowed(user, view) ? view : defaultView(user)
  const isAdminScreen = ADMIN_VIEWS.includes(allowed)

  const content = useMemo(() => {
    switch (allowed) {
      case 'pos':
        return <PosView />
      case 'kitchen':
        return <KitchenView />
      case 'dashboard':
        return <DashboardView onNavigate={setView} />
      case 'products':
        return <ProductsView />
      case 'categories':
        return <CategoriesView />
      case 'floorplans':
        return <FloorPlansView />
      case 'inventory':
        return <InventoryView />
      case 'recipes':
        return <RecipesView />
      case 'reports':
        return <ReportsView />
      case 'users':
        return <UsersView />
      case 'roles':
        return <RolesView />
      case 'attendance':
        return <AttendanceView />
      case 'settings':
        return <SettingsView />
      default:
        return <PosView />
    }
  }, [allowed, setView])

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <AppNavbar user={user} view={allowed} onNavigate={setView} onLogout={onLogout} />
      <main className="flex-1 flex flex-col">
        {content}
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
