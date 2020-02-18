import v8 from "v8"
import { readFileSync, writeFileSync, unlinkSync } from "fs-extra"
import { IReduxNode, ICachedReduxState } from "./types"
import { sync as globSync } from "glob"

const CWD = process.cwd()
const file = (): string => CWD + `/.cache/redux.state`
const chunkFilePrefix = (): string => CWD + `/.cache/redux.node.state_`

export const readFromCache = (): ICachedReduxState => {
  // The cache is stored in two steps; the nodes in chunks and the rest
  // First we revive the rest, then we inject the nodes into that obj (if any)
  // Each chunk is stored in its own file, this circumvents max buffer lengths
  // for sites with a _lot_ of content. Since all nodes go into a Map, the order
  // of reading them is not relevant.

  const obj: ICachedReduxState = v8.deserialize(readFileSync(file()))

  // Note: at 1M pages, this will be 1M/chunkSize chunks (ie. 1m/10k=100)
  const chunks = globSync(chunkFilePrefix() + "*").map(file =>
    v8.deserialize(readFileSync(file))
  )

  const nodes: [string, IReduxNode][] = [].concat(...chunks)

  if (chunks.length) {
    obj.nodes = new Map(nodes)
  }

  return obj
}

export const writeToCache = (contents: ICachedReduxState): void => {
  // Remove the old node files first, we may have fewer nodes than before and
  // must make sure that no excess files are kept around.
  globSync(chunkFilePrefix() + "*").forEach(file => unlinkSync(file))

  // Temporarily save the nodes and remove them from the main redux store
  // This prevents an OOM when the page nodes collectively contain to much data
  const map = contents.nodes
  contents.nodes = undefined
  writeFileSync(file(), v8.serialize(contents))
  // Now restore them on the redux store
  contents.nodes = map

  if (map) {
    // Now store the nodes separately, chunk size determined by a heuristic
    const values: [string, IReduxNode][] = [...map.entries()]
    const chunkSize = guessSafeChunkSize(values)
    const chunks = Math.ceil(values.length / chunkSize)

    for (let i = 0; i < chunks; ++i) {
      writeFileSync(
        `${chunkFilePrefix()}${i}`,
        v8.serialize(values.slice(i * chunkSize, i * chunkSize + chunkSize))
      )
    }
  }
}

function guessSafeChunkSize(values) {
  const valueCount = values.length

  // Pick a few random elements and measure their size.
  // Pick a chunk size ceiling based on the worst case.
  // This attempts to prevent small sites with very large pages from OOMing
  let maxSize = 0
  for (let i = 0; i < valueCount; i += Math.floor(valueCount / 11)) {
    const size = v8.serialize(values[i]).length
    maxSize = Math.max(size, maxSize)
  }

  // Max size of a Buffer is 2gb (yeah, we're assuming 64bit system)
  // https://stackoverflow.com/questions/8974375/whats-the-maximum-size-of-a-node-js-buffer
  // Use 1.5gb as the target ceiling, allowing for some margin of error
  return Math.floor((150 * 1024 * 1024 * 1024) / maxSize)
}
