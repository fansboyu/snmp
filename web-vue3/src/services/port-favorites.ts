import { readonly, ref } from 'vue'

const key = 'netlooker-port-favorites'
function read(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))] : []
  } catch { return [] }
}
const ids = ref<string[]>(read())
function save(next: string[]): void {
  const unique = [...new Set(next)]
  // Update the shared state only after persistence succeeds.
  localStorage.setItem(key, JSON.stringify(unique))
  ids.value = unique
}
window.addEventListener('storage', event => {
  if (event.key === key || event.key === null) ids.value = read()
})

export function usePortFavorites() {
  return {
    ids: readonly(ids),
    toggle(id: string) { save(ids.value.includes(id) ? ids.value.filter(value => value !== id) : [...ids.value, id]) },
    remove(id: string) { save(ids.value.filter(value => value !== id)) },
    replaceForDevice(devicePortIds: string[], selectedIds: string[]) {
      const allowed = new Set(devicePortIds)
      save([...ids.value.filter(id => !allowed.has(id)), ...selectedIds.filter(id => allowed.has(id))])
    }
  }
}
