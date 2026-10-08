'use client'

import {
  BarChart3,
  BookOpen,
  Boxes,
  CalendarCheck,
  CalendarDays,
  Cctv,
  ChefHat,
  ChevronDown,
  CircleHelp,
  CircleDollarSign,
  ClipboardCheck,
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
  Users,
  UserRound,
  Utensils,
  UtensilsCrossed,
  Wallet,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { motion } from 'motion/react'

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
import { startTour } from '@/components/tour/tour-bus'
import { PersonSwitcher } from '@/components/person-switcher'
import { cn } from '@/lib/utils'

type NavItem = { view: string; permission: string; icon: LucideIcon; always?: boolean }

type LocalNavItem = { view: string; label: string; icon: LucideIcon }

/** first-class tabs (shown directly on the bar) — R25: the Launcher Home
 *  leads on every device (always visible, no permission gate) */
const MAIN_ITEMS: NavItem[] = [
  { view: 'home', permission: 'home', icon: House, always: true },
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
  { view: 'reservations', permission: 'reservations', icon: CalendarCheck },
  { view: 'customers', permission: 'customers', icon: UserRound },
  { view: 'inventory', permission: 'inventory', icon: Boxes },
  { view: 'purchases', permission: 'purchases', icon: Truck },
  { view: 'stockcounts', permission: 'inventory', icon: ClipboardCheck },
  { view: 'recipes', permission: 'recipes', icon: BookOpen },
  { view: 'promotions', permission: 'promotions', icon: Zap },
  { view: 'reports', permission: 'reports', icon: BarChart3 },
  { view: 'cashdrawer', permission: 'cashdrawer', icon: CircleDollarSign },
  { view: 'vision', permission: 'vision', icon: Cctv },
  { view: 'users', permission: 'users', icon: Users },
  { view: 'roles', permission: 'roles', icon: ShieldCheck },
  { view: 'attendance', permission: 'attendance', icon: CalendarDays },
  { view: 'payroll', permission: 'payroll', icon: Wallet },
  { view: 'activity', permission: 'audit', icon: ScrollText },
  { view: 'integrations', permission: 'settings', icon: Plug },
  { view: 'settings', permission: 'settings', icon: Settings },
]

/* Soft role tints tuned for the deep plum-charcoal shell (r48 tokens) */
const ROLE_BADGE_CLASS: Record<string, string> = {
  admin: 'border-primary/60 bg-primary/30 text-white',
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
  const mainNav = MAIN_ITEMS.filter(
    (item) => isAdmin || item.always || perms.includes(item.permission),
  )
  const adminMenu = ADMIN_MENU.filter((item) => isAdmin || perms.includes(item.permission))
  const hasMenu = adminMenu.length > 0
  // R25: the brand button goes to the Launcher Home (the in-app Team Wall)
  const homeView = 'home'

  const roleLabel = user.role === 'custom' ? (user.roleName ?? t('role.custom')) : t(`role.${user.role}`)
  const initials =
    user.name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? '')
      .join('') || 'U'

  return (
    <header className="glass-shell sticky top-0 z-50 border-b border-shell-border bg-shell/90 text-shell-foreground shadow-sm">
      <div className="rms-scroll flex h-16 items-center gap-3 overflow-x-auto px-4 max-w-full">
        {/* Left: brand — gradient plum tile with a soft glow (r48) */}
        <button
          type="button"
          onClick={() => onNavigate(homeView)}
          aria-label={`${restaurantName} — ${t('nav.home')}`}
          className="flex shrink-0 items-center gap-2.5 rounded-lg px-1 py-1 transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-linear-to-br from-[oklch(0.48_0.1_338)] to-[oklch(0.32_0.09_338)] text-white shadow-[0_2px_12px_oklch(0.42_0.085_338/0.45)]">
            <UtensilsCrossed className="h-5 w-5" aria-hidden />
          </span>
          <span className="text-left rtl:text-right">
            <span className="block truncate font-semibold leading-tight text-white max-w-[140px] sm:max-w-none">
              {restaurantName}
            </span>
            <span className="block text-[10px] font-medium uppercase tracking-[0.14em] text-shell-muted">
              RMS Platform
            </span>
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
              pillId="nav-pill-mobile"
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
              pillId="nav-pill-desktop"
            />
          ))}
          {hasMenu && (
            <AdminMenu items={adminMenu} view={view} onNavigate={onNavigate} label={t('nav.admin')} />
          )}
        </nav>

        {/* Right: guided tour (R13) + language toggle + user chip + logout */}
        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:ml-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={startTour}
            aria-label={t('tour.helpAria')}
            title={t('tour.helpAria')}
            className="size-11 shrink-0 text-shell-muted transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-white/60"
          >
            <CircleHelp className="h-5 w-5" aria-hidden />
          </Button>
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
          {/* R19: who is operating this device (person-level attribution) */}
          <PersonSwitcher user={user} />
          <div className="flex min-w-0 items-center gap-2">
            <Avatar className="h-8 w-8 ring-1 ring-white/15">
              <AvatarFallback className="bg-linear-to-br from-[oklch(0.48_0.1_338)] to-[oklch(0.32_0.09_338)] text-xs font-bold text-white">
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
            className="size-11 shrink-0 text-shell-muted transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-white/60"
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
  pillId,
}: {
  item: LocalNavItem
  active: boolean
  onClick: () => void
  iconOnly?: boolean
  /** unique motion layoutId per nav instance (mobile vs desktop) */
  pillId: string
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
        'relative inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60',
        iconOnly ? 'h-11 w-11' : 'h-9 px-3',
        active
          ? 'text-white'
          : 'text-shell-muted hover:bg-white/10 hover:text-white',
      )}
    >
      {/* r48: the active pill slides between tabs (shared layout animation) */}
      {active && (
        <motion.span
          layoutId={pillId}
          className="absolute inset-0 rounded-lg bg-linear-to-b from-[oklch(0.48_0.1_338)] to-[oklch(0.38_0.09_338)] shadow-[0_2px_10px_oklch(0.42_0.085_338/0.5)]"
          transition={{ type: 'spring', stiffness: 480, damping: 38 }}
          aria-hidden
        />
      )}
      <span
        className={cn(
          'relative z-10 inline-flex items-center justify-center gap-1.5',
          active && 'font-medium',
        )}
      >
        <Icon className={iconOnly ? 'h-5 w-5' : 'h-4 w-4'} aria-hidden />
        {!iconOnly && item.label}
      </span>
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
            'shrink-0 rounded-lg transition-colors focus-visible:ring-white/60',
            iconOnly ? 'h-11 w-11 px-0' : 'h-9 gap-1.5 px-3 text-sm',
            menuActive
              ? 'bg-linear-to-b from-[oklch(0.48_0.1_338)] to-[oklch(0.38_0.09_338)] text-white shadow-[0_2px_10px_oklch(0.42_0.085_338/0.5)] hover:opacity-95'
              : 'text-shell-muted hover:bg-white/10 hover:text-white',
          )}
        >
          <Settings2 className={iconOnly ? 'h-5 w-5' : 'h-4 w-4'} aria-hidden />
          {!iconOnly && <span>{label}</span>}
          {!iconOnly && <ChevronDown className="h-4 w-4 opacity-60" aria-hidden />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48 card-elevated-2">
        {items.map((m) => {
          const Icon = m.icon
          return (
            <DropdownMenuItem
              key={m.view}
              onClick={() => onNavigate(m.view)}
              className={cn(
                'min-h-11 cursor-pointer py-2',
                view === m.view && 'bg-accent font-medium text-accent-foreground',
              )}
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
