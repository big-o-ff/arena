"use client"

import { useState, useEffect, useCallback, useRef } from "react"

const TETRIS_PIECES = [
  { shape: [[1, 1, 1, 1]], color: 'bg-[#39FF14]' },
  { shape: [[1, 1], [1, 1]], color: 'bg-[#39FF14]' },
  { shape: [[0, 1, 0], [1, 1, 1]], color: 'bg-[#39FF14]' },
  { shape: [[1, 0], [1, 0], [1, 1]], color: 'bg-[#39FF14]' },
  { shape: [[0, 1, 1], [1, 1, 0]], color: 'bg-[#39FF14]' },
  { shape: [[1, 1, 0], [0, 1, 1]], color: 'bg-[#39FF14]' },
  { shape: [[0, 1], [0, 1], [1, 1]], color: 'bg-[#39FF14]' },
]

const GRID_W = 8
const GRID_H = 12  // short and compact

interface Cell { filled: boolean; color: string }
interface FallingPiece { shape: number[][]; color: string; x: number; y: number; id: string }

export interface TetrisLoadingProps {
  size?: 'sm' | 'md' | 'lg'
  speed?: 'slow' | 'normal' | 'fast'
  showLoadingText?: boolean
  loadingText?: string
}

export default function TetrisLoading({
  size = 'md',
  speed = 'normal',
  showLoadingText = true,
  loadingText = 'Loading...'
}: TetrisLoadingProps) {
  const cellPx = size === 'sm' ? 14 : size === 'lg' ? 22 : 18
  // slower = smoother, more satisfying to watch
  const fallMs = speed === 'fast' ? 120 : speed === 'slow' ? 300 : 180

  const makeEmpty = (): Cell[][] =>
    Array(GRID_H).fill(null).map(() =>
      Array(GRID_W).fill(null).map(() => ({ filled: false, color: '' }))
    )

  const [grid, setGrid] = useState<Cell[][]>(makeEmpty)
  const [fallingPiece, setFallingPiece] = useState<FallingPiece | null>(null)
  const [isClearing, setIsClearing] = useState(false)

  const frameRef = useRef<number>()
  const lastTickRef = useRef<number>(0)
  // Mirrors of the latest state for the rAF loop to read. Assigned in an effect
  // rather than during render — writing a ref while rendering is not safe under
  // concurrent rendering, where a render can be discarded or replayed.
  const gridRef = useRef(grid)
  const clearingRef = useRef(isClearing)
  useEffect(() => {
    gridRef.current = grid
    clearingRef.current = isClearing
  }, [grid, isClearing])

  const rotateShape = (shape: number[][]): number[][] => {
    const rows = shape.length, cols = shape[0].length
    const out: number[][] = Array(cols).fill(null).map(() => Array(rows).fill(0))
    for (let i = 0; i < rows; i++)
      for (let j = 0; j < cols; j++)
        out[j][rows - 1 - i] = shape[i][j]
    return out
  }

  const spawnPiece = useCallback((): FallingPiece => {
    const p = TETRIS_PIECES[Math.floor(Math.random() * TETRIS_PIECES.length)]
    let shape = p.shape
    const rots = Math.floor(Math.random() * 4)
    for (let i = 0; i < rots; i++) shape = rotateShape(shape)
    const maxX = GRID_W - shape[0].length
    return {
      shape, color: p.color,
      x: Math.floor(Math.random() * (maxX + 1)),
      y: -shape.length,
      id: Math.random().toString(36).substr(2, 9),
    }
  }, [])

  const canPlace = useCallback((p: FallingPiece, nx: number, ny: number): boolean => {
    const g = gridRef.current
    for (let r = 0; r < p.shape.length; r++)
      for (let c = 0; c < p.shape[r].length; c++)
        if (p.shape[r][c]) {
          const gx = nx + c, gy = ny + r
          if (gx < 0 || gx >= GRID_W || gy >= GRID_H) return false
          if (gy >= 0 && g[gy][gx].filled) return false
        }
    return true
  }, [])

  const commitPiece = useCallback((p: FallingPiece) => {
    setGrid(prev => {
      const next = prev.map(row => row.map(c => ({ ...c })))
      for (let r = 0; r < p.shape.length; r++)
        for (let c = 0; c < p.shape[r].length; c++)
          if (p.shape[r][c]) {
            const gx = p.x + c, gy = p.y + r
            if (gy >= 0 && gy < GRID_H && gx >= 0 && gx < GRID_W)
              next[gy][gx] = { filled: true, color: p.color }
          }
      return next
    })
  }, [])

  const clearLines = useCallback(() => {
    setGrid(prev => {
      const full = prev.reduce<number[]>((acc, row, i) => {
        if (row.every(c => c.filled)) acc.push(i)
        return acc
      }, [])
      if (!full.length) return prev

      setIsClearing(true)
      setTimeout(() => {
        setGrid(cur => {
          const kept = cur.filter((_, i) => !full.includes(i))
          const blanks = Array(full.length).fill(null).map(() =>
            Array(GRID_W).fill(null).map(() => ({ filled: false, color: '' }))
          )
          setIsClearing(false)
          return [...blanks, ...kept]
        })
      }, 200)

      return prev.map((row, i) =>
        full.includes(i)
          ? row.map(() => ({ filled: true, color: 'bg-[#39FF14]/30 animate-pulse' }))
          : row
      )
    })
  }, [])

  const resetIfFull = useCallback((): boolean => {
    const g = gridRef.current
    if (g.slice(0, 2).some(row => row.filter(c => c.filled).length >= GRID_W * 0.5)) {
      setIsClearing(true)
      setTimeout(() => {
        setGrid(Array(GRID_H).fill(null).map(() =>
          Array(GRID_W).fill(null).map(() => ({ filled: false, color: '' }))
        ))
        setFallingPiece(null)
        setIsClearing(false)
      }, 400)
      return true
    }
    return false
  }, [])

  useEffect(() => {
    const loop = (ts: number) => {
      if (ts - lastTickRef.current >= fallMs) {
        lastTickRef.current = ts
        if (!clearingRef.current && !resetIfFull()) {
          setFallingPiece(prev => {
            if (!prev) return spawnPiece()
            const ny = prev.y + 1
            if (canPlace(prev, prev.x, ny)) return { ...prev, y: ny }
            commitPiece(prev)
            setTimeout(clearLines, 50)
            return spawnPiece()
          })
        }
      }
      frameRef.current = requestAnimationFrame(loop)
    }
    frameRef.current = requestAnimationFrame(loop)
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current) }
  }, [fallMs, spawnPiece, canPlace, commitPiece, clearLines, resetIfFull])

  // Build display grid
  const display = grid.map(row => row.map(c => ({ ...c })))
  if (fallingPiece && !isClearing) {
    for (let r = 0; r < fallingPiece.shape.length; r++)
      for (let c = 0; c < fallingPiece.shape[r].length; c++)
        if (fallingPiece.shape[r][c]) {
          const gx = fallingPiece.x + c, gy = fallingPiece.y + r
          if (gy >= 0 && gy < GRID_H && gx >= 0 && gx < GRID_W)
            display[gy][gx] = { filled: true, color: fallingPiece.color }
        }
  }

  const w = GRID_W * cellPx
  const h = GRID_H * cellPx

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className="relative overflow-hidden border border-[#39FF14]/20"
        style={{ width: w, height: h, background: '#050f05' }}
      >
        {/* subtle grid lines */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `linear-gradient(rgba(57,255,20,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(57,255,20,0.06) 1px, transparent 1px)`,
            backgroundSize: `${cellPx}px ${cellPx}px`,
          }}
        />
        {/* render only filled cells — empty cells = transparent, grid lines show */}
        {display.map((row, ri) =>
          row.map((cell, ci) =>
            cell.filled ? (
              <div
                key={`${ri}-${ci}`}
                className={`absolute ${cell.color}`}
                style={{ left: ci * cellPx + 1, top: ri * cellPx + 1, width: cellPx - 2, height: cellPx - 2 }}
              />
            ) : null
          )
        )}
      </div>

      {showLoadingText && (
        <p className="text-[#39FF14]/60 font-mono tracking-[0.25em] uppercase" style={{ fontSize: 11 }}>
          {loadingText}
        </p>
      )}
    </div>
  )
}