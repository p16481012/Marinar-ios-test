#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN
@interface NodeBridge : NSObject
+ (int)runWithArguments:(NSArray<NSString *> *)arguments workingDirectory:(NSString *)directory;
@end
NS_ASSUME_NONNULL_END
