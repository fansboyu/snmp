//go:build !windows

package collector

import "syscall"

func diskUsage(path string) (DiskUsage, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return DiskUsage{}, err
	}

	total := stat.Blocks * uint64(stat.Bsize)
	free := stat.Bavail * uint64(stat.Bsize)
	usedPercent := 0.0
	if total > 0 {
		usedPercent = float64(total-free) / float64(total) * 100
	}

	return DiskUsage{
		Path:        path,
		TotalBytes:  total,
		FreeBytes:   free,
		UsedPercent: usedPercent,
	}, nil
}
