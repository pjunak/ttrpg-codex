package workersupervisor

import "sync"

type tailBuffer struct {
	mu      sync.Mutex
	maximum int
	value   []byte
}

func newTailBuffer(maximum int) *tailBuffer {
	return &tailBuffer{maximum: maximum, value: make([]byte, 0, maximum)}
}

func (buffer *tailBuffer) Write(value []byte) (int, error) {
	written := len(value)
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	if len(value) >= buffer.maximum {
		buffer.value = append(buffer.value[:0], value[len(value)-buffer.maximum:]...)
		return written, nil
	}
	overflow := len(buffer.value) + len(value) - buffer.maximum
	if overflow > 0 {
		copy(buffer.value, buffer.value[overflow:])
		buffer.value = buffer.value[:len(buffer.value)-overflow]
	}
	buffer.value = append(buffer.value, value...)
	return written, nil
}

func (buffer *tailBuffer) String() string {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return string(append([]byte(nil), buffer.value...))
}
