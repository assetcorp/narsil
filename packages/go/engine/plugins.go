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

func (runner *pluginRunner) insert(ctx context.Context, name hookName, insert *model.InsertContext) error {
	return runner.each(ctx, name, func(plugin model.Plugin) func(context.Context) error {
		hook := plugin.BeforeInsert
		if name == hookAfterInsert {
			hook = plugin.AfterInsert
		}
		if hook == nil {
			return nil
		}
		return func(ctx context.Context) error { return hook(ctx, insert) }
	})
}

func (runner *pluginRunner) update(ctx context.Context, name hookName, update *model.UpdateContext) error {
	return runner.each(ctx, name, func(plugin model.Plugin) func(context.Context) error {
		hook := plugin.BeforeUpdate
		if name == hookAfterUpdate {
			hook = plugin.AfterUpdate
		}
		if hook == nil {
			return nil
		}
		return func(ctx context.Context) error { return hook(ctx, update) }
	})
}

func (runner *pluginRunner) remove(ctx context.Context, name hookName, remove *model.RemoveContext) error {
	return runner.each(ctx, name, func(plugin model.Plugin) func(context.Context) error {
		hook := plugin.BeforeRemove
		if name == hookAfterRemove {
			hook = plugin.AfterRemove
		}
		if hook == nil {
			return nil
		}
		return func(ctx context.Context) error { return hook(ctx, remove) }
	})
}

func (runner *pluginRunner) search(ctx context.Context, name hookName, search *model.SearchContext) error {
	return runner.each(ctx, name, func(plugin model.Plugin) func(context.Context) error {
		hook := plugin.BeforeSearch
		if name == hookAfterSearch {
			hook = plugin.AfterSearch
		}
		if hook == nil {
			return nil
		}
		return func(ctx context.Context) error { return hook(ctx, search) }
	})
}

func (runner *pluginRunner) index(ctx context.Context, name hookName, index *model.IndexContext) error {
	return runner.each(ctx, name, func(plugin model.Plugin) func(context.Context) error {
		hook := plugin.OnIndexCreate
		if name == hookOnIndexDrop {
			hook = plugin.OnIndexDrop
		}
		if hook == nil {
			return nil
		}
		return func(ctx context.Context) error { return hook(ctx, index) }
	})
}

func (runner *pluginRunner) hasRemoveHooks() bool {
	return runner.has(func(plugin model.Plugin) bool { return plugin.BeforeRemove != nil || plugin.AfterRemove != nil })
}

func (runner *pluginRunner) hasUpdateHooks() bool {
	return runner.has(func(plugin model.Plugin) bool { return plugin.BeforeUpdate != nil || plugin.AfterUpdate != nil })
}
