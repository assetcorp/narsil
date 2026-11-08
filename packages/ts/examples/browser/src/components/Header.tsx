import { AppHeader, type HeaderTab } from '@delali/narsil-example-shared/components/layout/AppHeader'
import { ArrowLeftRight, BarChart3, Database, FileText, FlaskConical, Inspect, MapPinned, Search } from 'lucide-react'

const tabs: HeaderTab[] = [
  { to: '/', label: 'Datasets', icon: Database, tabId: 'datasets' },
  { to: '/search', label: 'Search', icon: Search, tabId: 'search' },
  { to: '/relevance', label: 'Relevance', icon: FlaskConical, tabId: 'relevance' },
  { to: '/benchmark', label: 'Benchmark', icon: BarChart3, tabId: 'benchmark' },
  { to: '/inspector', label: 'Inspector', icon: Inspect, tabId: 'inspector' },
  { to: '/documents', label: 'Documents', icon: FileText, tabId: 'documents' },
  { to: '/map', label: 'Map', icon: MapPinned, tabId: 'map' },
  { to: '/sync', label: 'Sync', icon: ArrowLeftRight, tabId: 'sync' },
]

export default function Header() {
  return <AppHeader appLabel="browser" tabs={tabs} />
}
