import { SidepanelState } from './sidepanel-state.js'
import { SidepanelJson } from './sidepanel-json.js'
import { ImagePreviews } from './sidepanel-image-previews.js'

const { panelState, panelElements } = SidepanelState

let previewBatch = ImagePreviews.createBatch()
let descriptionObserver: ResizeObserver | undefined

const renderMetadata = () => {
  descriptionObserver?.disconnect()
  previewBatch.dispose()
  const data = panelState.metadata
  previewBatch = ImagePreviews.createBatch(
    panelState.tabId !== null && data?.documentId && data.pageUrl
      ? {
          tabId: panelState.tabId,
          documentId: data.documentId,
          origin: new URL(data.pageUrl).origin,
        }
      : undefined,
  )
  if (panelState.mode !== 'metadata') {
    return
  }
  if (!data || data.error) {
    panelElements.metadataView.replaceChildren(
      SidepanelJson.emptyState(
        data?.error ||
          (panelState.tabId === null
            ? 'Select a normal page tab to view page metadata.'
            : 'Loading page metadata…'),
      ),
    )
    return
  }
  const nodes = []
  for (const [key, title] of [
    ['canonical', 'Canonical URL'],
    data.openGraph?.length || !data.twitter?.length
      ? (['openGraph', 'Open Graph'] as const)
      : (['twitter', 'Twitter Card'] as const),
  ] as const) {
    const heading = document.createElement('h2')
    heading.textContent = title
    nodes.push(heading)
    const entries = data[key] || []
    if (!entries.length) {
      nodes.push(SidepanelJson.emptyState('Not specified'))
      continue
    }
    if (key === 'canonical') {
      const urls = document.createElement('div')
      for (const entry of entries) {
        const url = document.createElement('p')
        url.className = 'metadata-canonical'
        url.textContent = entry.value || '(empty)'
        linkMetadataUrl(url, entry.value, data.baseUrl)
        urls.append(url)
      }
      nodes.push(urls)
      continue
    }
    const list = document.createElement('dl')
    const additionalList = document.createElement('dl')
    const grouped = groupMetadataEntries(entries)
    for (const entry of sortMetadata(grouped)) {
      const name = document.createElement('dt')
      name.textContent = entry.key
      const value = document.createElement('dd')
      value.textContent = entry.values
        ? JSON.stringify(entry.values, null, 2)
        : entry.value || '(empty)'
      if (
        ['og:description', 'twitter:description'].includes(
          entry.key.toLowerCase(),
        )
      ) {
        const text = document.createElement('div')
        text.className = 'metadata-description'
        text.textContent = value.textContent
        const toggle = document.createElement('button')
        toggle.type = 'button'
        toggle.className = 'metadata-description-toggle'
        toggle.textContent = 'Show more'
        toggle.hidden = true
        toggle.setAttribute('aria-expanded', 'false')
        toggle.addEventListener('click', () => {
          const expanded = toggle.getAttribute('aria-expanded') !== 'true'
          text.classList.toggle('expanded', expanded)
          toggle.setAttribute('aria-expanded', String(expanded))
          toggle.textContent = expanded ? 'Show less' : 'Show more'
        })
        value.replaceChildren(text, toggle)
        descriptionObserver ??= new ResizeObserver((observations) => {
          for (const { target } of observations) {
            const text = target as HTMLElement
            const toggle = text.nextElementSibling as HTMLButtonElement
            const lineHeight = Number.parseFloat(
              getComputedStyle(text).lineHeight,
            )
            // Measure again when the panel width changes, including expanded text.
            toggle.hidden = text.scrollHeight <= lineHeight * 6 + 1
          }
        })
        descriptionObserver.observe(text)
      }
      if (imageUrlKeys.includes(entry.key.toLowerCase())) {
        linkMetadataUrl(value, entry.value, data.baseUrl)
      }
      const imageUrl = metadataImageUrl(entry, data.baseUrl)
      if (imageUrl) {
        const reloadButton = document.createElement('button')
        reloadButton.type = 'button'
        reloadButton.className = 'metadata-image-reload'
        reloadButton.textContent = '↻'
        reloadButton.title = 'Reload image'
        reloadButton.setAttribute('aria-label', `Reload ${entry.key} image`)
        reloadButton.disabled = true
        name.append(reloadButton)
        let image: HTMLImageElement | undefined
        const status = document.createElement('span')
        status.className = 'metadata-image-error'
        status.textContent = 'Loading image…'
        value.append(status)
        const reload = previewBatch.load(
          imageUrl,
          (blobUrl) => {
            image = document.createElement('img')
            image.className = 'metadata-image'
            image.alt = entry.key
            image.addEventListener('load', () => {
              status.hidden = true
              reloadButton.disabled = false
            })
            image.addEventListener('error', () => {
              image?.remove()
              reloadButton.disabled = false
              status.textContent = 'Image unavailable'
            })
            image.src = blobUrl
            value.append(image)
          },
          (message) => {
            status.textContent = message
            reloadButton.disabled = false
          },
        )
        if (reload) {
          reloadButton.addEventListener('click', () => {
            if (reloadButton.disabled) {
              return
            }
            reloadButton.disabled = true
            image?.remove()
            status.hidden = false
            status.textContent = 'Loading image…'
            reload()
          })
        } else {
          reloadButton.disabled = true
        }
      }
      const additional =
        key === 'openGraph' &&
        !['og:image', 'og:title', 'og:description'].includes(
          entry.key.toLowerCase(),
        )
      const targetList = additional ? additionalList : list
      targetList.append(name, value)
    }
    nodes.push(list)
    if (additionalList.children.length) {
      const details = document.createElement('details')
      details.className = 'metadata-additional'
      const summary = document.createElement('summary')
      summary.textContent = 'Other properties'
      details.append(summary, additionalList)
      nodes.push(details)
    }
  }
  panelElements.metadataView.replaceChildren(...nodes)
}

// Open Graph display order: og:image, og:title, og:description, then all
// other keys in alphabetical order (including og:image:* attributes).
// Twitter Card follows the same order with twitter:* keys.
// Keep repeated keys in source order (including multiple images).
const sortMetadata = (entries: MetadataEntry[]) => {
  const priority = (key: string) => {
    if (key === 'og:image' || key === 'twitter:image') {
      return 0
    }
    if (key === 'og:title' || key === 'twitter:title') {
      return 1
    }
    if (key === 'og:description' || key === 'twitter:description') {
      return 2
    }
    return 3
  }
  return [...entries].sort((a, b) => {
    const left = a.key.toLowerCase()
    const right = b.key.toLowerCase()
    const difference = priority(left) - priority(right)
    // Keep the prioritized image entries in source order.
    if (difference || priority(left) < 3) {
      return difference
    }
    return left < right ? -1 : left > right ? 1 : 0
  })
}

const imageUrlKeys = [
  'og:image',
  'og:image:url',
  'og:image:secure_url',
  'twitter:image',
  'twitter:image:src',
]

const metadataWebUrl = (value: string, baseUrl: string | undefined) => {
  if (!value.trim()) {
    return null
  }
  try {
    const url = new URL(value, baseUrl)
    // Page-provided URLs must never become executable or privileged links.
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url
      : null
  } catch {
    return null
  }
}

const linkMetadataUrl = (
  element: HTMLElement,
  value: string,
  baseUrl: string | undefined,
) => {
  const url = metadataWebUrl(value, baseUrl)
  if (!url) {
    return
  }
  const link = document.createElement('a')
  link.href = url.href
  link.textContent = value
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  element.replaceChildren(link)
}

const metadataImageUrl = (
  entry: MetadataEntry,
  baseUrl: string | undefined,
) => {
  if (!imageUrlKeys.includes(entry.key.toLowerCase())) {
    return null
  }
  const url = metadataWebUrl(entry.value, baseUrl)
  return url?.protocol === 'https:' ? url.href : null
}

const groupMetadataEntries = (entries: MetadataEntry[]) => {
  const grouped: MetadataEntry[] = []
  const groups = new Map<string, MetadataEntry>()
  for (const entry of entries) {
    const key = entry.key.toLowerCase()
    if (imageUrlKeys.includes(key)) {
      grouped.push(entry)
      continue
    }
    let group = groups.get(key)
    if (!group) {
      group = { ...entry }
      groups.set(key, group)
      grouped.push(group)
    } else {
      group.values ??= [group.value]
      group.values.push(entry.value)
    }
  }
  return grouped
}

const initializeMetadata = () => {
  window.addEventListener('pagehide', () => {
    previewBatch.dispose()
    descriptionObserver?.disconnect()
  })
}

export const SidepanelMetadata = { renderMetadata, initializeMetadata }
