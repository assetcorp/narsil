export const TERM_SLOT = 0
export const GROUP_SLOT = 1
export const PHRASE_SLOT = 2

export const SLOT_STRIDE = 4
export const SLOT_KIND = 0
export const SLOT_TERM = 1
export const SLOT_LIST_END = 2
export const SLOT_VALUE_END = 3

export const LIST_STRIDE = 3
export const LIST_FLAGS = 0
export const LIST_START = 1
export const LIST_LENGTH = 2

export const LIST_FROM_ROWS = 1
export const LIST_ORDERED = 2

export const LIST_VALUE_STRIDE = 2
export const LIST_DOCUMENT_FREQUENCY = 0
export const LIST_FACTOR = 0
export const LIST_PARTIAL_FACTOR = 1

export const FIELD_BOOSTS = 0
export const FIELD_AVERAGE_LENGTHS = 1
export const FIELD_K1 = 2
export const FIELD_B = 3
export const FIELD_NUMBER_COLUMNS = 4

export const SETTING_SLOTS = 0
export const SETTING_TERMS = 1
export const SETTING_CAPACITY = 2
export const SETTING_TOTAL_DOCUMENTS = 3
export const SETTING_TERM_MATCH = 4
export const SETTING_ANCHOR = 5
export const SETTING_LIMIT = 6
export const SETTING_MIN_SCORE = 7
export const SETTING_COLLECT = 8
export const SETTING_COUNT = 9

export const NO_LIMIT = -1

export const OUTCOME_COUNT = 0
export const OUTCOME_TOTAL_MATCHED = 1
export const OUTCOME_SCORING_PATH = 2
export const OUTCOME_LENGTH = 3

export const SCORED_IN_FULL = 0
export const PRUNED = 1
export const PRUNED_THEN_FULL = 2
