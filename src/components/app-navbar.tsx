'use client'

import {
  BarChart3,
  BookOpen,
  Boxes,
  CalendarCheck,
  Cctv,
  ChefHat,
  ChevronDown,
  CircleDollarSign,
  Languages,
  LayoutDashboard,
  LogOut,
  Map,
  Package,
  ScrollText,
  Settings,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Tags,
  Users,
  Utensils,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useI18n } from '@/lib/i18n'
import { useAppSettings } from '@/lib/use-settings'
import type { SessionUser } from '@/lib/types'
import { cn } from '@/lib/utils'

type NavItem = { view: string; permission: string; icon: LucideIcon }

type LocalNavItem = { view: string; label: string; icon: LucideIcon }

/** first-class tabs (shown directly on the bar) */
const MAIN_ITEMS: NavItem[] = [
  { view: 'pos', permission: 'pos', icon: Utensils },
  { view: 'kitchen', permission: 'kitchen', icon: ChefHat },
  { view: 'dashboard', permission: 'dashboard', icon: LayoutDashboard },
]

/** everything else lives under the "Admin" dropdown */
const ADMIN_MENU: NavItem[] = [
  { view: 'products', permission: 'products', icon: Package },
  { view: 'modifiers', permission: 'products', icon: SlidersHorizontal },
  { view: 'categories', permission: 'categories', icon: Tags },
  { view: 'floorplans', permission: 'floorplans', icon: Map },
  { view: 'inventory', permission: 'inventory', icon: Boxes },
  { view: 'recipes', permission: 'recipes', icon: BookOpen },
  { view: 'reports', permission: 'reports', icon: BarChart3 },
  { view: 'cashdrawer', permission: 'cashdrawer', icon: CircleDollarSign },
  { view: 'vision', permission: 'vision', icon: Cctv },
  { view: 'users', permission: 'users', icon: Users },
  { view: 'roles', permission: 'roles', icon: ShieldCheck },
  { view: 'attendance', permission: 'attendance', icon: CalendarCheck },
  { view: 'activity', permission: 'audit', icon: ScrollText },
  { view: 'settings', permission: 'settings', icon: Settings },
]

/* Soft role tints tuned for the dark Odoo navbar bar (#24232D) */
const ROLE_BADGE_CLASS: Record<string, string> = {
  admin: 'border-primary/60 bg-primary/25 text-white',
  waiter: 'border-emerald-400/30 bg-emerald-400/15 text-emerald-100',
  kitchen: 'border-rose-400/30 bg-rose-400/15 text-rose-100',
  custom: 'border-amber-400/30 bg-amber-400/15 text-amber-100',
}

export default function AppNavbar({
  user,
  view,
  onNavigate,
  onLogout,
}: {
  user: SessionUser
  view: string
  onNavigate: (view: string) => void
  onLogout: () => void
}) {
  const { t, lang, toggleLang } = useI18n()
  const { restaurantName } = useAppSettings()

  const isAdmin = user.role === 'admin'
  const perms = user.permissions ?? []
  const mainNav = MAIN_ITEMS.filter((item) => isAdmin || perms.includes(item.permission))
  const adminMenu = ADMIN_MENU.filter((item) => isAdmin || perms.includes(item.permission))
  const hasMenu = adminMenu.length > 0
  const homeView = isAdmin
    ? 'dashboard'
    : (mainNav[0]?.view ?? adminMenu[0]?.view ?? 'pos')

  const roleLabel = user.role === 'custom' ? (user.roleName ?? t('role.custom')) : t(`role.${user.role}`)
  const initials =
    user.name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? '')
      .join('') || 'U'

  return (
    <header className="sticky top-0 z-50 border-b border-black/30 bg-[#24232D] text-white shadow-sm">
      <div className="rms-scroll flex h-16 items-center gap-3 overflow-x-auto px-4 max-w-full">
        {/* Left: brand (Odoo-style plum logo tile on the dark bar) */}
        <button
          type="button"
          onClick={() => onNavigate(homeView)}
          aria-label={`${restaurantName} — ${t('nav.home')}`}
          className="flex shrink-0 items-center gap-2.5 rounded-lg px-1 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <span className="bg-primary text-primary-foreground grid h-9 w-9 shrink-0 place-items-center rounded-lg shadow-sm">
            <UtensilsCrossed className="h-5 w-5" aria-hidden />
          </span>
          <span className="text-left rtl:text-right">
            <span className="block truncate font-semibold leading-tight text-white max-w-[140px] sm:max-w-none">
              {restaurantName}
            </span>
            <span className="block text-[10px] uppercase tracking-wider text-white/50">RMS</span>
          </span>
        </button>

        {/* Mobile nav (icon-only) */}
        <nav aria-label={t('nav.home')} className="flex items-center gap-1 sm:hidden">
          {mainNav.map((item) => (
            <NavTab
              key={item.view}
              item={{ view: item.view, label: t(`nav.${item.view}`), icon: item.icon }}
              active={view === item.view}
              onClick={() => onNavigate(item.view)}
              iconOnly
            />
          ))}
          {hasMenu && (
            <AdminMenu items={adminMenu} view={view} onNavigate={onNavigate} iconOnly label={t('nav.admin')} />
          )}
        </nav>

        {/* Center nav (desktop) */}
        <nav aria-label={t('nav.home')} className="mx-auto hidden items-center gap-1 sm:flex">
          {mainNav.map((item) => (
            <NavTab
              key={item.view}
              item={{ view: item.view, label: t(`nav.${item.view}`), icon: item.icon }}
              active={view === item.view}
              onClick={() => onNavigate(item.view)}
            />
          ))}
          {hasMenu && (
            <AdminMenu items={adminMenu} view={view} onNavigate={onNavigate} label={t('nav.admin')} />
          )}
        </nav>

        {/* Right: language toggle + user chip + logout */}
        <div className="ml-auto flex shrink-0 items-center gap-2 sm:ml-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleLang}
            aria-label={lang === 'en' ? t('lang.arabic') : t('lang.english')}
            title={lang === 'en' ? t('lang.arabic') : t('lang.english')}
            className="size-11 shrink-0 text-white/70 hover:bg-white/10 hover:text-white focus-visible:ring-white/60"
          >
            <Languages className="h-5 w-5" aria-hidden />
          </Button>
          <div className="flex min-w-0 items-center gap-2">
            <Avatar className="h-8 w-8">
              <AvatarFallback className="bg-primary text-primary-foreground text-xs font-bold">
                {initials}
              </AvatarFallback>
            </Avatar>
            <div className="hidden min-w-0 flex-col items-start gap-0.5 md:flex rtl:items-end">
              <span className="max-w-[140px] truncate text-sm font-medium text-white">{user.name}</span>
              <Badge
                variant="outline"
                className={cn(ROLE_BADGE_CLASS[user.role] ?? 'border-white/15 bg-white/10 text-white/80')}
              >
                {roleLabel}
              </Badge>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onLogout}
            aria-label={t('nav.logout')}
            title={t('nav.logout')}
            className="size-11 shrink-0 text-white/70 hover:bg-white/10 hover:text-white focus-visible:ring-white/60"
          >
            <LogOut className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>
    </header>
  )
}

function NavTab({
  item,
  active,
  onClick,
  iconOnly,
}: {
  item: LocalNavItem
  active: boolean
  onClick: () => void
  iconOnly?: boolean
}) {
  const Icon = item.icon
  return (
    <button
      type="button"
      onClick={onClick}
      title={item.label}
      aria-label={item.label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60',
        iconOnly ? 'h-11 w-11' : 'h-9 px-3',
        active
          ? 'bg-primary text-white font-medium shadow-sm'
          : 'text-white/70 hover:bg-white/10 hover:text-white',
      )}
    >
      <Icon className={iconOnly ? 'h-5 w-5' : 'h-4 w-4'} aria-hidden />
      {!iconOnly && item.label}
    </button>
  )
}

function AdminMenu({
  items,
  view,
  onNavigate,
  iconOnly,
  label,
}: {
  items: NavItem[]
  view: string
  onNavigate: (view: string) => void
  iconOnly?: boolean
  label: string
}) {
  const { t } = useI18n()
  const menuActive = items.some((m) => m.view === view)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          aria-label={label}
          title={label}
          className={cn(
            'shrink-0 rounded-lg text-white/70 hover:bg-white/10 hover:text-white focus-visible:ring-white/60',
            iconOnly ? 'h-11 w-11 px-0' : 'h-9 gap-1.5 px-3 text-sm',
            menuActive && 'bg-primary text-white shadow-sm hover:bg-primary/90 hover:text-white',
          )}
        >
          <Settings2 className={iconOnly ? 'h-5 w-5' : 'h-4 w-4'} aria-hidden />
          {!iconOnly && <span>{label}</span>}
          {!iconOnly && <ChevronDown className="h-4 w-4 opacity-60" aria-hidden />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {items.map((m) => {
          const Icon = m.icon
          return (
            <DropdownMenuItem
              key={m.view}
              onClick={() => onNavigate(m.view)}
              className="min-h-11 cursor-pointer py-2"
            >
              <Icon className="h-4 w-4" aria-hidden />
              {t(`nav.${m.view}`)}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
