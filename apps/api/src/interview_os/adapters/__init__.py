"""Adapters over the outside world — port of `apps/server/src/adapters`."""

from .git import clone_shallow, validate_git_source

__all__ = ["clone_shallow", "validate_git_source"]
