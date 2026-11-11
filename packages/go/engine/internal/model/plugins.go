package model

import "context"

type InsertContext struct {
	IndexName string
	DocID     string
	Document  *Document
}

type RemoveContext struct {
	IndexName string
	DocID     string
}

type UpdateContext struct {
	IndexName   string
	DocID       string
	OldDocument *Document
	NewDocument *Document
}

type SearchContext struct {
	IndexName string
	Params    *QueryParams
	Results   *QueryResult
}

type IndexContext struct {
	IndexName string
	Config    IndexConfig
}

type PartitionContext struct {
	IndexName         string
	OldPartitionCount int
	NewPartitionCount int
}

type WorkerContext struct {
	WorkerCount int
	Reason      string
}

type Plugin struct {
	Name             string
	BeforeInsert     func(ctx context.Context, insert *InsertContext) error
	AfterInsert      func(ctx context.Context, insert *InsertContext) error
	BeforeRemove     func(ctx context.Context, remove *RemoveContext) error
	AfterRemove      func(ctx context.Context, remove *RemoveContext) error
	BeforeUpdate     func(ctx context.Context, update *UpdateContext) error
	AfterUpdate      func(ctx context.Context, update *UpdateContext) error
	BeforeSearch     func(ctx context.Context, search *SearchContext) error
	AfterSearch      func(ctx context.Context, search *SearchContext) error
	OnIndexCreate    func(ctx context.Context, index *IndexContext) error
	OnIndexDrop      func(ctx context.Context, index *IndexContext) error
	OnPartitionSplit func(ctx context.Context, partition *PartitionContext) error
	OnWorkerPromote  func(ctx context.Context, worker *WorkerContext) error
}
