'use client'

import {
  BarChart3,
  BookOpen,
  Boxes,
  ChefHat,
  ChevronDown,
  LayoutDashboard,
  LogOut,
  Map,
  Package,
  Settings2,
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
import { RESTAURANT_NAME, ROLE_LABELS } from '@/lib/constants'
import type { SessionUser } from '@/lib/types'
import { cn } from '@/lib/utils'

type NavItem = { view: string; label: string; icon: LucideIcon }

const MAIN_NAV: Record<string, NavItem[]> = {
  waiter: [{ view: 'pos', label: 'POS', icon: Utensils }],
  kitchen: [{ view: 'kitchen', label: 'Kitchen', icon: ChefHat }],
  admin: [
    { view: 'pos', label: 'POS', icon: Utensils },
    { view: 'kitchen', label: 'Kitchen', icon: ChefHat },
    { view: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  ],
}

const ADMIN_MENU: NavItem[] = [
  { view: 'products', label: 'Products', icon: Package },
  { view: 'categories', label: 'Categories', icon: Tags },
  { view: 'floorplans', label: 'Floor Plans', icon: Map },
  { view: 'inventory', label: 'Inventory', icon: Boxes },
  { view: 'recipes', label: 'Recipes', icon: BookOpen },
  { view: 'reports', label: 'Reports', icon: BarChart3 },
  { view: 'users', label: 'Users', icon: Users },
]

/* Soft role tints tuned for the dark Odoo navbar bar (#24232D) */
const ROLE_BADGE_CLASS: Record<string, string> = {
  admin: 'border-primary/60 bg-primary/25 text-white',
  waiter: 'border-emerald-400/30 bg-emerald-400/15 text-emerald-100',
  kitchen: 'border-rose-400/30 bg-rose-400/15 text-rose-100',
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
  const mainNav = MAIN_NAV[user.role] ?? MAIN_NAV.waiter
  const isAdmin = user.role === 'admin'
  const defaultView = user.role === 'admin' ? 'dashboard' : mainNav[0].view
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
          onClick={() => onNavigate(defaultView)}
          aria-label={`${RESTAURANT_NAME} — go to home view`}
          className="flex shrink-0 items-center gap-2.5 rounded-lg px-1 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <span className="bg-primary text-primary-foreground grid h-9 w-9 shrink-0 place-items-center rounded-lg shadow-sm">
            <UtensilsCrossed className="h-5 w-5" aria-hidden />
          </span>
          <span className="text-left">
            <span className="block truncate font-semibold leading-tight text-white max-w-[140px] sm:max-w-none">
              {RESTAURANT_NAME}
            </span>
            <span className="block text-[10px] uppercase tracking-wider text-white/50">RMS</span>
          </span>
        </button>

        {/* Mobile nav (icon-only) */}
        <nav aria-label="Main navigation" className="flex items-center gap-1 sm:hidden">
          {mainNav.map((item) => (
            <NavTab
              key={item.view}
              item={item}
              active={view === item.view}
              onClick={() => onNavigate(item.view)}
              iconOnly
            />
          ))}
          {isAdmin && <AdminMenu view={view} onNavigate={onNavigate} iconOnly />}
        </nav>

        {/* Center nav (desktop) */}
        <nav aria-label="Main navigation" className="mx-auto hidden items-center gap-1 sm:flex">
          {mainNav.map((item) => (
            <NavTab
              key={item.view}
              item={item}
              active={view === item.view}
              onClick={() => onNavigate(item.view)}
            />
          ))}
          {isAdmin && <AdminMenu view={view} onNavigate={onNavigate} />}
        </nav>

        {/* Right: user chip + logout */}
        <div className="ml-auto flex shrink-0 items-center gap-2 sm:ml-0">
          <div className="flex min-w-0 items-center gap-2">
            <Avatar className="h-8 w-8">
              <AvatarFallback className="bg-primary text-primary-foreground text-xs font-bold">
                {initials}
              </AvatarFallback>
            </Avatar>
            <div className="hidden min-w-0 flex-col items-start gap-0.5 md:flex">
              <span className="max-w-[140px] truncate text-sm font-medium text-white">{user.name}</span>
              <Badge
                variant="outline"
                className={cn(ROLE_BADGE_CLASS[user.role] ?? 'border-white/15 bg-white/10 text-white/80')}
              >
                {ROLE_LABELS[user.role] ?? user.role}
              </Badge>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onLogout}
            aria-label="Log out"
            title="Log out"
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
  item: NavItem
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
  view,
  onNavigate,
  iconOnly,
}: {
  view: string
  onNavigate: (view: string) => void
  iconOnly?: boolean
}) {
  const menuActive = ADMIN_MENU.some((m) => m.view === view)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          aria-label="Admin menu"
          title="Admin"
          className={cn(
            'shrink-0 rounded-lg text-white/70 hover:bg-white/10 hover:text-white focus-visible:ring-white/60',
            iconOnly ? 'h-11 w-11 px-0' : 'h-9 gap-1.5 px-3 text-sm',
            menuActive && 'bg-primary text-white shadow-sm hover:bg-primary/90 hover:text-white',
          )}
        >
          <Settings2 className={iconOnly ? 'h-5 w-5' : 'h-4 w-4'} aria-hidden />
          {!iconOnly && <span>Admin</span>}
          {!iconOnly && <ChevronDown className="h-4 w-4 opacity-60" aria-hidden />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {ADMIN_MENU.map((m) => {
          const Icon = m.icon
          return (
            <DropdownMenuItem
              key={m.view}
              onClick={() => onNavigate(m.view)}
              className="min-h-11 cursor-pointer py-2"
            >
              <Icon className="h-4 w-4" aria-hidden />
              {m.label}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
