import { describe, expect, it } from 'vitest'
import { exportQuery } from './export-query'
import {
  activeFilterCount,
  filtersToApi,
  filtersToSearch,
  searchToFilters,
  usageLogFiltersQuery,
  validateLogsSearch,
} from './search'

describe('request ID lookup', () => {
  it('survives the URL round trip and sends exact server filters without default muting', () => {
    const filters = {
      requestId: 'outer-r1',
      correlationId: 'outer',
      statusCode: 503,
    }
    expect(
      searchToFilters(validateLogsSearch(filtersToSearch(filters)))
    ).toMatchObject(filters)
    const api = filtersToApi(filters, ['auth'])
    expect(api.excludeErrorClass).toBeUndefined()
    const query = usageLogFiltersQuery(api)
    expect(query.get('request_id')).toBe('outer-r1')
    expect(query.get('correlation_id')).toBe('outer')
    expect(query.get('status_code')).toBe('503')
    expect(activeFilterCount(filters)).toBe(3)
  })
  it('trims pasted IDs and reuses the same filters for export', () => {
    const filters = { requestId: ' outer-r1 ', correlationId: ' outer ' }
    expect(filtersToSearch(filters)).toEqual({
      requestId: 'outer-r1',
      correlationId: 'outer',
    })
    const query = exportQuery(
      {
        scope: 'current',
        format: 'jsonl',
        limit: 100,
        window: '',
        includeMuted: false,
        errorClass: '',
      },
      filters,
      ['auth']
    )
    expect(query.get('request_id')).toBe('outer-r1')
    expect(query.get('correlation_id')).toBe('outer')
  })
})
