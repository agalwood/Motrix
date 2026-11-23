import type { AddTaskFormValues } from '@shared/schemas/add-task'
import { useCallback } from 'react'
import { useFormContext } from 'react-hook-form'

export function useTorrentFileSelection() {
  const { setValue, clearErrors } = useFormContext<AddTaskFormValues>()
  return useCallback(
    (indices: number[]) => {
      // A checkbox change must not parse/copy the entire torrent metadata via
      // the form resolver. The footer checks nonempty selection; submission
      // still validates the complete request with the shared schema.
      setValue('selectedFiles', indices, { shouldDirty: true })
      if (indices.length) clearErrors('selectedFiles')
    },
    [setValue, clearErrors]
  )
}
