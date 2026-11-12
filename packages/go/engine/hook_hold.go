package engine

type indexHolder struct {
	name    string
	acquire func(name string) (*indexEntry, func(), error)
}

func (n *Narsil) holderOf(indexName string) indexHolder {
	return indexHolder{name: indexName, acquire: n.acquire}
}

func (holder indexHolder) reacquire() (*indexEntry, func(), error) {
	entry, release, err := holder.acquire(holder.name)
	if err != nil {
		return nil, releasedNothing, err
	}
	return entry, release, nil
}

func (holder indexHolder) outside(release func(), run func() error) (*indexEntry, func(), error) {
	release()
	ranErr := run()
	entry, held, err := holder.reacquire()
	if err != nil {
		return nil, releasedNothing, err
	}
	return entry, held, ranErr
}

func (n *Narsil) settleWrites(entry *indexEntry, touched touchedVectors) {
	entry.scheduleVectorBuilds(touched)
	clear(touched)
	n.afterWrite(entry)
}
