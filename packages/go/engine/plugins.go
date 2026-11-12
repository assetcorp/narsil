package engine

import (
	"context"
	"fmt"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type pluginRunner struct {
	plugins []model.Plugin
}

type hookName string

const (
	hookBeforeInsert  hookName = "beforeInsert"
	hookAfterInsert   hookName = "afterInsert"
	hookBeforeRemove  hookName = "beforeRemove"
	hookAfterRemove   hookName = "afterRemove"
	hookBeforeUpdate  hookName = "beforeUpdate"
	hookAfterUpdate   hookName = "afterUpdate"
	hookBeforeSearch  hookName = "beforeSearch"
	hookAfterSearch   hookName = "afterSearch"
	hookOnIndexCreate hookName = "onIndexCreate"
	hookOnIndexDrop   hookName = "onIndexDrop"
)

func rejectsWrites(name hookName) bool {
	return name == hookBeforeInsert || name == hookBeforeUpdate || name == hookBeforeRemove
}

func asWriteRejection(err error, plugin string, name hookName) error {
	if _, isEngineError := narsilerr.As(err); isEngineError {
		return err
	}
	return narsilerr.New(narsilerr.CodeDocValidationFailed, err.Error(), map[string]any{"plugin": plugin, "hook": string(name)})
}

func invokeHook(ctx context.Context, plugin string, name hookName, run func(context.Context) error) (err error) {
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		err = fmt.Errorf("the %s hook of plugin %q panicked: %v", name, plugin, recovered)
		if rejectsWrites(name) {
			err = asWriteRejection(err, plugin, name)
		}
	}()
	if err := run(ctx); err != nil {
		if rejectsWrites(name) {
			return asWriteRejection(err, plugin, name)
		}
		return err
	}
	return nil
}

func (runner *pluginRunner) each(ctx context.Context, name hookName, pick func(model.Plugin) func(context.Context) error) error {
	for _, plugin := range runner.plugins {
		run := pick(plugin)
		if run == nil {
			continue
		}
		if err := invokeHook(ctx, plugin.Name, name, run); err != nil {
			return err
		}
	}
	return nil
}

func (runner *pluginRunner) has(pick func(model.Plugin) bool) bool {
	for _, plugin := range runner.plugins {
		if pick(plugin) {
			return true
		}
	}
	return false
}

type pluginHook[C any] func(ctx context.Context, hooked *C) error

func runHooks[C any](ctx context.Context, runner *pluginRunner, name hookName, later hookName, hooked *C,
	hooksOf func(model.Plugin) (pluginHook[C], pluginHook[C])) error {
	return runner.each(ctx, name, func(plugin model.Plugin) func(context.Context) error {
		hook, laterHook := hooksOf(plugin)
		if name == later {
			hook = laterHook
		}
		if hook == nil {
			return nil
		}
		return func(ctx context.Context) error { return hook(ctx, hooked) }
	})
}

func (runner *pluginRunner) insert(ctx context.Context, name hookName, insert *model.InsertContext) error {
	return runHooks(ctx, runner, name, hookAfterInsert, insert, func(plugin model.Plugin) (pluginHook[model.InsertContext], pluginHook[model.InsertContext]) {
		return plugin.BeforeInsert, plugin.AfterInsert
	})
}

func (runner *pluginRunner) update(ctx context.Context, name hookName, update *model.UpdateContext) error {
	return runHooks(ctx, runner, name, hookAfterUpdate, update, func(plugin model.Plugin) (pluginHook[model.UpdateContext], pluginHook[model.UpdateContext]) {
		return plugin.BeforeUpdate, plugin.AfterUpdate
	})
}

func (runner *pluginRunner) remove(ctx context.Context, name hookName, remove *model.RemoveContext) error {
	return runHooks(ctx, runner, name, hookAfterRemove, remove, func(plugin model.Plugin) (pluginHook[model.RemoveContext], pluginHook[model.RemoveContext]) {
		return plugin.BeforeRemove, plugin.AfterRemove
	})
}

func (runner *pluginRunner) search(ctx context.Context, name hookName, search *model.SearchContext) error {
	return runHooks(ctx, runner, name, hookAfterSearch, search, func(plugin model.Plugin) (pluginHook[model.SearchContext], pluginHook[model.SearchContext]) {
		return plugin.BeforeSearch, plugin.AfterSearch
	})
}

func (runner *pluginRunner) index(ctx context.Context, name hookName, index *model.IndexContext) error {
	return runHooks(ctx, runner, name, hookOnIndexDrop, index, func(plugin model.Plugin) (pluginHook[model.IndexContext], pluginHook[model.IndexContext]) {
		return plugin.OnIndexCreate, plugin.OnIndexDrop
	})
}

func pluginDefines(plugin model.Plugin, name hookName) bool {
	switch name {
	case hookBeforeInsert:
		return plugin.BeforeInsert != nil
	case hookAfterInsert:
		return plugin.AfterInsert != nil
	case hookBeforeRemove:
		return plugin.BeforeRemove != nil
	case hookAfterRemove:
		return plugin.AfterRemove != nil
	case hookBeforeUpdate:
		return plugin.BeforeUpdate != nil
	case hookAfterUpdate:
		return plugin.AfterUpdate != nil
	case hookBeforeSearch:
		return plugin.BeforeSearch != nil
	case hookAfterSearch:
		return plugin.AfterSearch != nil
	}
	return false
}

func (runner *pluginRunner) hasHook(name hookName) bool {
	return runner.has(func(plugin model.Plugin) bool { return pluginDefines(plugin, name) })
}

func (runner *pluginRunner) hasUpdateHooks() bool {
	return runner.has(func(plugin model.Plugin) bool { return plugin.BeforeUpdate != nil || plugin.AfterUpdate != nil })
}
