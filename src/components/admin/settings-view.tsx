'use client'

// Placeholder — agent 6-e replaces this with the full Settings view
// (restaurant profile + shifts cards).

export default function SettingsView() {
  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Restaurant profile &amp; shifts</p>
      </div>
      <div className="rounded-xl border border-dashed p-8 text-center text-muted-foreground text-sm">
        Loading settings module…
      </div>
    </div>
  )
}
