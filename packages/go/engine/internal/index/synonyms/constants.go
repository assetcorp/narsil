package synonyms

const (
	maxSynonymRules             = 100_000
	maxSynonymWords             = 500_000
	maxSynonymWordBytes         = 4_194_304
	maxSynonymRuleWords         = 100
	minTwoWaySynonymWords       = 2
	minOneWaySynonyms           = 1
	synonymsAddedPerQuery       = 50
	synonymCacheEntries         = 1_024
	synonymCacheShards          = 16
	synonymCacheEntriesPerShard = synonymCacheEntries / synonymCacheShards
)
