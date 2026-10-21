#import "NodeBridge.h"
#include <NodeMobile/NodeMobile.h>
#include <unistd.h>
#include <vector>
#include <cstring>

@implementation NodeBridge
+ (int)runWithArguments:(NSArray<NSString *> *)arguments workingDirectory:(NSString *)directory {
    // node_start may run only once in an application process. libuv requires
    // argv strings in contiguous writable memory for process-title handling.
    static bool started = false;
    @synchronized(self) {
        if (started) return -2;
        started = true;
    }
    if (chdir(directory.fileSystemRepresentation) != 0) return -3;
    size_t size = 0;
    for (NSString *argument in arguments) size += strlen(argument.UTF8String) + 1;
    std::vector<char> storage(size);
    std::vector<char *> argv(arguments.count + 1, nullptr);
    char *cursor = storage.data();
    NSUInteger index = 0;
    for (NSString *argument in arguments) {
        const size_t length = strlen(argument.UTF8String) + 1;
        memcpy(cursor, argument.UTF8String, length);
        argv[index++] = cursor;
        cursor += length;
    }
    return node_start((int)arguments.count, argv.data());
}
@end
