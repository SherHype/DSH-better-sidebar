/**
 * The file explorer: a lazy VSCode-style tree rooted at the session's
 * working directory. Levels load on expansion (one API call per directory),
 * directories sort first, hidden entries render dimmed, and the expansion
 * set lives in the per-session state. Clicking a file opens an editor tab.
 *
 * Row actions: hovering a row reveals an @-reference button on the far
 * right (appends `@<relative path>` to the composer draft), and right-click
 * opens a context menu to copy the relative or absolute path (with a brief
 * "copied" label replacing the button after a successful write); file rows
 * also offer a download action (the host serves raw bytes, binary-safe).
 *
 * File management: the header's upload button (and dropping files onto the
 * tree) uploads into the session workspace — the host streams the raw bytes
 * to the destination and the tree refreshes; the context menu deletes files
 * and directories behind a confirm modal (recursive for directories).
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconCloseOutline16, IconCodeOutline16, IconCopyOutline16, IconDownloadOutline16, IconEditOutline16,
  IconFolderClose16, IconFolderOpen16, IconLinkOutline16, IconRefreshOutline16, IconTrashOutline16, Menu, Modal,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { api, downloadUrl, uploadFile, type FsEntry } from './api.ts'
import { IconUploadOutline16 } from './icons.tsx'
import { relativeTo } from './paths.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

interface LevelData {
  entries?: FsEntry[]
  error?: string
}

/** Root label: the last path segment (mirror of the host rootLabel). */
function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

/** How long the row's "copied" label stays after a successful write. */
const COPIED_MS = 1200

/** A pending delete (shown in the confirm modal before removal). */
interface PendingDelete {
  path: string
  name: string
  isDir: boolean
}

/** A pending upload batch held back for overwrite confirmation. */
interface PendingUpload {
  files: File[]
  dir: string
  /** Names that already exist in the target directory (from the cached tree). */
  conflicts: string[]
}

/** The one shared confirm modal: delete or overwrite confirmation. */
type ConfirmState =
  | { kind: 'delete'; target: PendingDelete }
  | { kind: 'overwrite'; upload: PendingUpload }

/** A browser File[] from a FileList (drop / file input). */
function toFiles(list: FileList | File[]): File[] {
  return Array.from(list)
}

/** Normalize separators for path comparisons (Windows-safe). */
function normPath(path: string): string {
  return path.replace(/\\/g, '/')
}

export function ExplorerView(props: {
  sessionId: string
  cwd: string | undefined
  expanded: string[]
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** Insert `@<relative path>` into the composer draft. */
  onReferenceFile: (path: string) => void
}) {
  const { sessionId, cwd, expanded, onToggle, onOpenFile, onReferenceFile } = props
  const [data, setData] = useState<Record<string, LevelData>>({})
  const dataRef = useRef(data)
  const [refreshTick, setRefreshTick] = useState(0)
  /** The row whose path was just copied ("copied" label replaces its button). */
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  /** Open context menu: the row path (and whether it is a directory) plus the cursor position. */
  const [rowMenu, setRowMenu] = useState<{ path: string; name: string; isDir: boolean; x: number; y: number } | null>(null)
  /** The shared delete / overwrite confirm modal. */
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  /** Upload in flight (buttons disabled; the tree refreshes at the end). */
  const [uploading, setUploading] = useState(false)
  /** Transient action banner (upload / delete / rename failure) above the tree. */
  const [banner, setBanner] = useState<string | null>(null)
  /** A file drag is hovering the explorer (drop-to-upload target mark). */
  const [dragOver, setDragOver] = useState(false)
  /** The row being renamed inline (its path, to render the input in place). */
  const [renaming, setRenaming] = useState<{ path: string } | null>(null)
  /** Live value of the inline rename input. */
  const [renameValue, setRenameValue] = useState('')
  /** Completing the rename (Enter/blur) must be processed exactly once. */
  const renameDoneRef = useRef(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  /** The explorer root element (drag interception) and the tree body (drop styling). */
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const storeLevel = useCallback((path: string, level: LevelData) => {
    dataRef.current = { ...dataRef.current, [path]: level }
    setData(dataRef.current)
  }, [])

  const loadDir = useCallback((dir: string) => {
    if (dataRef.current[dir] !== undefined) return
    storeLevel(dir, {})
    api.fsTree({ sessionId, cwd }, dir).then((listing) => {
      storeLevel(dir, { entries: listing.entries })
    }).catch((error: unknown) => {
      storeLevel(dir, { error: error instanceof Error ? error.message : String(error) })
    })
  }, [sessionId, cwd, storeLevel])

  useEffect(() => {
    // Load the visible set; already-loaded levels (kept in the cache) are
    // not refetched. Only the refresh wipes the cache.
    const root = cwd
    if (root === undefined) return
    loadDir(root)
    for (const dir of expanded) loadDir(dir)
  }, [cwd, expanded, refreshTick, loadDir])

  /** Wipe the level cache and reload everything the user can see. */
  const refresh = useCallback((): void => {
    dataRef.current = {}
    setData({})
    setRefreshTick(tick => tick + 1)
  }, [])

  /** Copy `text`; on success flip the row's copied label for a moment. */
  const copyPath = useCallback((text: string, path: string): void => {
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopiedPath(path)
      window.setTimeout(() => {
        setCopiedPath(current => current === path ? null : current)
      }, COPIED_MS)
    })
  }, [])

  /** The row's trailing actions: the @-reference button, or the copied label. */
  const rowActions = (entry: FsEntry): ReactNode => {
    if (copiedPath === entry.path) {
      return <span className={css.explorerCopied}>{t('copied')}</span>
    }
    return (
      <button
        type="button"
        className={css.explorerRef}
        aria-label={t('referenceFile')}
        title={t('referenceFile')}
        onClick={(event) => {
          event.stopPropagation()
          onReferenceFile(entry.path)
        }}
      >
        {t('referenceFile')}
      </button>
    )
  }

  /** Row name cell: the inline rename input while editing, else the plain name. */
  const nameCell = (entry: FsEntry): ReactNode => {
    if (renaming?.path !== entry.path) {
      return <span className={css.explorerName}>{entry.name}</span>
    }
    return (
      <input
        ref={renameInputRef}
        className={css.explorerNameInput}
        value={renameValue}
        aria-label={t('rename')}
        onChange={(event) => { setRenameValue(event.target.value) }}
        onClick={(event) => { event.stopPropagation() }}
        onKeyDown={(event) => {
          // Keep the row's own Enter/Space handler (toggle/open) from firing.
          event.stopPropagation()
          if (event.key === 'Enter') {
            event.preventDefault()
            renameDoneRef.current = true
            commitRename()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            renameDoneRef.current = true
            setRenaming(null)
          }
        }}
        onBlur={() => { if (!renameDoneRef.current) commitRename() }}
      />
    )
  }

  const openRowMenu = (event: MouseEvent, path: string, name: string, isDir: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    setRowMenu({ path, name, isDir, x: event.clientX, y: event.clientY })
  }

  /** Download a file through the host route (raw bytes, binary-safe). */
  const downloadFile = (path: string): void => {
    const url = downloadUrl({ sessionId, cwd }, path)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  /** Upload one batch of files into `dir`, refreshing the tree afterwards. */
  const uploadBatch = useCallback(async (files: File[], dir: string): Promise<void> => {
    if (files.length === 0) return
    setUploading(true)
    setBanner(null)
    try {
      for (const file of files) await uploadFile({ sessionId, cwd }, dir, file)
      refresh()
    } catch (error) {
      setBanner(`${t('uploadFailed')}：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setUploading(false)
    }
  }, [sessionId, cwd, refresh])

  /**
   * Entry point for the picker and the drop: pre-check overwrite conflicts
   * against the cached tree, then either upload straight away or hold the
   * batch behind the overwrite confirm modal.
   */
  const enqueueUpload = useCallback((files: File[], dir: string): void => {
    if (files.length === 0) return
    const loaded = dataRef.current[dir]
    const conflicts = loaded?.entries === undefined
      ? []
      : files.filter(file => {
        const target = normPath(`${dir.replace(/[\\/]+$/, '')}/${file.name}`)
        return loaded.entries!.some(entry => !entry.isDir && normPath(entry.path) === target)
      })
    if (conflicts.length === 0) {
      void uploadBatch(files, dir)
      return
    }
    setConfirm({ kind: 'overwrite', upload: { files, dir, conflicts: conflicts.map(file => file.name) } })
  }, [uploadBatch])

  /** Delete one file or directory after confirmation, then refresh. */
  const runDelete = useCallback(async (target: PendingDelete): Promise<void> => {
    setBanner(null)
    try {
      await api.fsDelete({ sessionId, cwd }, target.path)
      refresh()
    } catch (error) {
      setBanner(`${t('deleteFailed')}：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [sessionId, cwd, refresh])

  /** Enter inline rename mode for a row (its name preselected in the input). */
  const startRename = useCallback((path: string, name: string): void => {
    renameDoneRef.current = false
    setRenaming({ path })
    setRenameValue(name)
  }, [])

  /** Commit the inline rename (Enter or blur). No-op when unchanged. */
  const commitRename = useCallback((): void => {
    const target = renaming
    if (target === null) return
    const value = renameValue.trim()
    if (value === '' || value === baseName(target.path)) {
      setRenaming(null)
      return
    }
    setBanner(null)
    // The row unmounts with the input; the done-ref keeps blur from double-firing.
    api.fsRename({ sessionId, cwd }, target.path, value).then(() => {
      refresh()
    }).catch((error: unknown) => {
      setBanner(`${t('renameFailed')}：${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      renameDoneRef.current = true
      setRenaming(null)
    })
  }, [renaming, renameValue, sessionId, cwd, refresh])

  // Focus and select the inline input when a rename starts.
  useEffect(() => {
    if (renaming === null) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [renaming])

  // Drag-to-upload: intercept file drags over the whole explorer (the
  // composer's document-level drop handlers would otherwise claim them for
  // message attachments). Native listeners on the root element so
  // stopPropagation keeps the composer's image-drop overlay away from the
  // sidebar while the pointer is over it.
  useEffect(() => {
    const el = rootRef.current
    const root = cwd
    if (el === null || root === undefined) return
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false
    const targetDirOf = (event: DragEvent): string => {
      const hit = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null
      return hit?.closest('[data-explorer-dir]')?.getAttribute('data-explorer-dir') ?? root
    }
    const onEnter = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      event.stopPropagation()
      setDragOver(true)
    }
    const onOver = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      event.stopPropagation()
    }
    const onLeave = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.stopPropagation()
      const related = event.relatedTarget
      if (related === null || !(related instanceof Node) || !el.contains(related)) setDragOver(false)
    }
    const onDrop = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      event.stopPropagation()
      setDragOver(false)
      const files = event.dataTransfer?.files
      const dir = targetDirOf(event)
      if (files !== undefined && files.length > 0) enqueueUpload(toFiles(files), dir)
    }
    el.addEventListener('dragenter', onEnter)
    el.addEventListener('dragover', onOver)
    el.addEventListener('dragleave', onLeave)
    el.addEventListener('drop', onDrop)
    return () => {
      el.removeEventListener('dragenter', onEnter)
      el.removeEventListener('dragover', onOver)
      el.removeEventListener('dragleave', onLeave)
      el.removeEventListener('drop', onDrop)
    }
  }, [cwd, enqueueUpload])

  const root = cwd

  const renderLevel = (dir: string, depth: number): ReactNode => {
    const level = data[dir]
    if (level === undefined) {
      return <div className={css.explorerRow} style={{ paddingLeft: depth * 22 + 6 }}>{t('loading')}</div>
    }
    if (level.error !== undefined) {
      return (
        <div className={clsx(css.explorerRow, css.explorerError)} style={{ paddingLeft: depth * 22 + 6 }}>
          {level.error}
        </div>
      )
    }
    const entries = level.entries ?? []
    return entries.map(entry => {
      if (entry.isDir) {
        const isOpen = expanded.includes(entry.path)
        return (
          <div key={entry.path}>
            <div
              role="button"
              tabIndex={0}
              data-explorer-dir={dir}
              className={clsx(css.explorerRow, css.explorerDir, entry.hidden && css.explorerHidden)}
              style={{ paddingLeft: depth * 22 + 6 }}
              onClick={() => { onToggle(entry.path) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onToggle(entry.path)
                }
              }}
              onContextMenu={(event) => { openRowMenu(event, entry.path, entry.name, true) }}
            >
              {isOpen ? <IconFolderOpen16 size={14} /> : <IconFolderClose16 size={14} />}
              {nameCell(entry)}
              {entry.isSymlink && <IconLinkOutline16 size={12} className={css.explorerSymlink} />}
              {rowActions(entry)}
            </div>
            {isOpen && renderLevel(entry.path, depth + 1)}
          </div>
        )
      }
      return (
        <div
          key={entry.path}
          role="button"
          tabIndex={0}
          data-explorer-dir={dir}
          className={clsx(css.explorerRow, entry.hidden && css.explorerHidden, entry.broken && css.explorerBroken)}
          style={{ paddingLeft: depth * 22 + 6 }}
          title={entry.broken ? `${entry.path} — ${t('brokenSymlink')}` : entry.path}
          onClick={() => { onOpenFile(entry.path) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onOpenFile(entry.path)
            }
          }}
          onContextMenu={(event) => { openRowMenu(event, entry.path, entry.name, false) }}
        >
          <IconCodeOutline16 size={14} />
          {nameCell(entry)}
          {entry.isSymlink && <IconLinkOutline16 size={12} className={css.explorerSymlink} />}
          {rowActions(entry)}
        </div>
      )
    })
  }

  return (
    <div ref={rootRef} className={css.explorer}>
      <div className={css.explorerHeader}>
        <span className={css.explorerRoot} title={root}>{root === undefined ? t('noSession') : baseName(root)}</span>
        <div className={css.explorerHeaderActions}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('upload')}
            title={t('upload')}
            disabled={root === undefined || uploading}
            onClick={() => { fileInputRef.current?.click() }}
          >
            <IconUploadOutline16 size={14} />
          </button>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('refresh')}
            title={t('refresh')}
            onClick={refresh}
          >
            <IconRefreshOutline16 size={14} />
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = event.target.files
            if (files !== null && root !== undefined && files.length > 0) enqueueUpload(toFiles(files), root)
            event.target.value = ''
          }}
        />
      </div>
      <div
        ref={bodyRef}
        className={clsx(css.explorerBody, dragOver && css.explorerBodyDrop)}
      >
        {dragOver && <div className={css.explorerDropHint}>{t('dropToUpload')}</div>}
        {banner !== null && (
          <div className={css.explorerBanner} role="alert">
            <span>{banner}</span>
            <button
              type="button"
              className={css.explorerBannerDismiss}
              aria-label={t('close')}
              title={t('close')}
              onClick={() => { setBanner(null) }}
            >
              <IconCloseOutline16 size={14} />
            </button>
          </div>
        )}
        {root === undefined ? (
          <div className={css.explorerEmpty}>{t('noSession')}</div>
        ) : (
          <>
            <div
              role="button"
              tabIndex={0}
              data-explorer-dir={root}
              className={clsx(css.explorerRow, dragOver && css.explorerHidden)}
              style={{ paddingLeft: 6 }}
              onClick={(event) => { event.stopPropagation() }}
              onContextMenu={(event) => { openRowMenu(event, root, baseName(root), true) }}
            >
              <IconFolderOpen16 size={14} />
              <span className={css.explorerName}>{baseName(root)}</span>
              {copiedPath === root
                ? <span className={css.explorerCopied}>{t('copied')}</span>
                : (
                  <button
                    type="button"
                    className={css.explorerRef}
                    aria-label={t('referenceFile')}
                    title={t('referenceFile')}
                    onClick={(event) => {
                      event.stopPropagation()
                      onReferenceFile(root)
                    }}
                  >
                    {t('referenceFile')}
                  </button>
                )}
            </div>
            {data[root] !== undefined && renderLevel(root, 1)}
          </>
        )}
      </div>
      {/*
        The one shared context menu, positioned at the right-click cursor
        (portal so the explorer's overflow clip cannot crop it).
      */}
      <Menu
        open={rowMenu !== null}
        onClose={() => { setRowMenu(null) }}
        items={[
          // Download applies to files only (the host route refuses directories).
          ...(rowMenu?.isDir === false
            ? [{ id: 'download', label: t('download'), icon: <IconDownloadOutline16 size={14} /> }]
            : []),
          { id: 'rename', label: t('rename'), icon: <IconEditOutline16 size={14} /> },
          { id: 'delete', label: t('delete'), icon: <IconTrashOutline16 size={14} />, danger: true },
          { type: 'separator', id: 'sep' },
          { id: 'relative', label: t('copyRelative'), icon: <IconCopyOutline16 size={14} /> },
          { id: 'absolute', label: t('copyAbsolute'), icon: <IconCopyOutline16 size={14} /> },
        ]}
        onSelect={(id) => {
          const target = rowMenu
          if (target === null) return
          setRowMenu(null)
          if (id === 'download') {
            downloadFile(target.path)
            return
          }
          if (id === 'rename') {
            startRename(target.path, target.name)
            return
          }
          if (id === 'delete') {
            setConfirm({ kind: 'delete', target: { path: target.path, name: target.name, isDir: target.isDir } })
            return
          }
          copyPath(
            id === 'relative' ? relativeTo(cwd ?? '', target.path) : target.path,
            target.path,
          )
        }}
        portal
        align="start"
        getAnchorRect={() => (rowMenu === null ? null : new DOMRect(rowMenu.x, rowMenu.y, 0, 0))}
        anchor={<span />}
      />

      {/* The shared delete / overwrite confirm modal (destructive actions
          land here first: Cancel / Confirm). */}
      <Modal
        open={confirm !== null}
        onClose={() => { setConfirm(null) }}
        title={confirm?.kind === 'delete' ? t('deleteTitle') : t('uploadOverwriteTitle')}
        closeLabel={t('cancel')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setConfirm(null) }}>{t('cancel')}</Button>
            {confirm?.kind === 'delete' && (
              <Button
                variant="primary"
                onClick={() => {
                  const pending = confirm
                  if (pending === null) return
                  setConfirm(null)
                  void runDelete(pending.target)
                }}
              >
                {t('delete')}
              </Button>
            )}
            {confirm?.kind === 'overwrite' && (
              <Button
                variant="primary"
                disabled={uploading}
                onClick={() => {
                  const pending = confirm
                  if (pending === null) return
                  setConfirm(null)
                  void uploadBatch(pending.upload.files, pending.upload.dir)
                }}
              >
                {t('uploadOverwrite')}
              </Button>
            )}
          </>
        )}
      >
        {confirm?.kind === 'delete' && (
          <p className={css.gitConfirmDesc}>
            {confirm.target.isDir
              ? t('deleteDirDesc', { name: confirm.target.name })
              : t('deleteFileDesc', { name: confirm.target.name })}
          </p>
        )}
        {confirm?.kind === 'overwrite' && (
          <p className={css.gitConfirmDesc}>
            {t('uploadOverwriteDesc', { name: confirm.upload.conflicts[0] ?? confirm.upload.files[0]?.name ?? '' })}
          </p>
        )}
      </Modal>
    </div>
  )
}