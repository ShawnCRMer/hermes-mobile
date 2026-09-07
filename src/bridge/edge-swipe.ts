const EDGE_ZONE_PX = 20
const MIN_TRAVEL_PX = 60
const VELOCITY_THRESHOLD = 300
const CANCEL_RATIO = 0.5

interface SwipeState {
  active: boolean
  startX: number
  startY: number
  startTime: number
  currentX: number
  maxTravel: number
  edge: 'left' | 'right' | null
}

let state: SwipeState = {
  active: false, startX: 0, startY: 0, startTime: 0,
  currentX: 0, maxTravel: 0, edge: null,
}

let onSwipeCommit: ((edge: 'left' | 'right') => void) | null = null

function handleTouchStart(e: TouchEvent): void {
  const touch = e.touches[0]
  if (!touch) return

  const x = touch.clientX
  const w = window.innerWidth

  let edge: 'left' | 'right' | null = null
  if (x <= EDGE_ZONE_PX) edge = 'left'
  else if (x >= w - EDGE_ZONE_PX) edge = 'right'

  if (!edge) return

  state = {
    active: true,
    startX: x,
    startY: touch.clientY,
    startTime: Date.now(),
    currentX: x,
    maxTravel: 0,
    edge,
  }
}

function handleTouchMove(e: TouchEvent): void {
  if (!state.active) return
  const touch = e.touches[0]
  if (!touch) return

  const dy = Math.abs(touch.clientY - state.startY)
  if (dy > 50 && state.maxTravel < MIN_TRAVEL_PX) {
    state.active = false
    return
  }

  state.currentX = touch.clientX
  const travel = state.edge === 'left'
    ? touch.clientX - state.startX
    : state.startX - touch.clientX
  if (travel > state.maxTravel) state.maxTravel = travel
}

function handleTouchEnd(): void {
  if (!state.active || !state.edge) {
    state.active = false
    return
  }

  const travel = state.edge === 'left'
    ? state.currentX - state.startX
    : state.startX - state.currentX
  const elapsed = (Date.now() - state.startTime) / 1000
  const velocity = elapsed > 0 ? travel / elapsed : 0

  const cancelled = travel < state.maxTravel * CANCEL_RATIO

  if (!cancelled && travel >= MIN_TRAVEL_PX && velocity >= VELOCITY_THRESHOLD) {
    onSwipeCommit?.(state.edge)
  }

  state.active = false
}

export function installEdgeSwipe(callback: (edge: 'left' | 'right') => void): () => void {
  onSwipeCommit = callback

  document.addEventListener('touchstart', handleTouchStart, { passive: true })
  document.addEventListener('touchmove', handleTouchMove, { passive: true })
  document.addEventListener('touchend', handleTouchEnd, { passive: true })
  document.addEventListener('touchcancel', handleTouchEnd, { passive: true })

  return () => {
    onSwipeCommit = null
    document.removeEventListener('touchstart', handleTouchStart)
    document.removeEventListener('touchmove', handleTouchMove)
    document.removeEventListener('touchend', handleTouchEnd)
    document.removeEventListener('touchcancel', handleTouchEnd)
  }
}
