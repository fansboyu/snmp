//go:build windows

package collector

import (
	"syscall"
	"unsafe"
)

var (
	kernel32            = syscall.NewLazyDLL("kernel32.dll")
	getDiskFreeSpaceExW = kernel32.NewProc("GetDiskFreeSpaceExW")
)

func diskUsage(path string) (DiskUsage, error) {
	pathPtr, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return DiskUsage{}, err
	}

	var freeAvailable uint64
	var total uint64
	var totalFree uint64
	result, _, callErr := getDiskFreeSpaceExW.Call(
		uintptr(unsafe.Pointer(pathPtr)),
		uintptr(unsafe.Pointer(&freeAvailable)),
		uintptr(unsafe.Pointer(&total)),
		uintptr(unsafe.Pointer(&totalFree)),
	)
	if result == 0 {
		if callErr != syscall.Errno(0) {
			return DiskUsage{}, callErr
		}
		return DiskUsage{}, syscall.EINVAL
	}

	usedPercent := 0.0
	if total > 0 {
		usedPercent = float64(total-freeAvailable) / float64(total) * 100
	}

	return DiskUsage{
		Path:        path,
		TotalBytes:  total,
		FreeBytes:   freeAvailable,
		UsedPercent: usedPercent,
	}, nil
}
